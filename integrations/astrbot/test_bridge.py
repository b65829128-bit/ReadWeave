"""Local contract/security tests. Fake chat events are not external-Harness acceptance."""

import asyncio
import json
import sys
import time
import unittest
from pathlib import Path

import httpx
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parent))
from astrbot_plugin_readweave.bridge import Bridge


class FakeChatApi:
    def __init__(self):
        self.calls = []
        self.hold = asyncio.Event()
        self.sending = asyncio.Event()
        self.sessions = 0
        self.runs = 0
        self.stop_gate = None
        self.stop_entered = asyncio.Event()
        self.fail_stop = False
        self.fail_delete = False
        self.busy_reads = 0

    async def request(self, key, method, path):
        self.calls.append((method, path))
        if path.endswith("/new"):
            self.sessions += 1
            return {
                "session_id": "owned_session"
                if self.sessions == 1
                else f"owned_session_{self.sessions}"
            }
        if method == "POST" and path.endswith("/stop"):
            self.stop_entered.set()
            if self.stop_gate:
                await self.stop_gate.wait()
            if self.fail_stop:
                raise ValueError("synthetic stop failure")
        if method == "DELETE" and self.fail_delete:
            raise ValueError("synthetic delete failure")
        if method == "GET":
            if self.busy_reads:
                self.busy_reads -= 1
                return {"is_running": True, "active_runs": [{"run_id": "backend_run"}]}
            return {"is_running": False, "active_runs": []}
        return {"stopped_count": 1}

    async def stream(self, key, actor, session, prompt):
        self.sending.set()
        self.runs += 1
        yield {"type": "session_id", "session_id": session}
        yield {
            "type": "run_started",
            "data": {
                "run_id": "backend_run"
                if self.runs == 1
                else f"backend_run_{self.runs}"
            },
        }
        if prompt == "wait":
            await self.hold.wait()
        yield {"type": "plain", "data": "解释", "chain_type": "normal"}
        yield {"type": "plain", "data": "思考", "chain_type": "reasoning"}
        yield {
            "type": "plain",
            "data": "untrusted tool text",
            "chain_type": "tool_call_result",
        }
        yield {"type": "complete"}
        yield {"type": "end"}


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.active = True

        async def authenticate(raw):
            if raw != "abk_synthetic":
                raise HTTPException(401)
            return "actor_1", "hash_1"

        async def active(_):
            return self.active

        self.api = FakeChatApi()
        self.bridge = Bridge(authenticate, active, self.api)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.bridge.app), base_url="http://test"
        )

    async def asyncTearDown(self):
        await self.bridge.close()
        await self.client.aclose()

    async def dispatch(self, action, body):
        return await self.bridge.dispatch(
            action, body, "abk_synthetic", "actor_1", "hash_1"
        )

    async def open(self):
        response = await self.dispatch("open", {})
        self.topic = self.bridge.topics[response["topic"]]
        return response["topic"]

    async def pump(self, until_ready=False, before_response=None):
        polled = await self.dispatch("poll", {"topic": self.topic.token})
        for frame in polled["frames"]:
            if "id" not in frame:
                continue
            if frame["method"] == "initialize":
                result = {
                    "protocolVersion": frame["params"]["protocolVersion"],
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "local-fixture", "version": "1"},
                }
            elif frame["method"] == "tools/list":
                result = {
                    "tools": [
                        {"name": name, "inputSchema": {"type": "object"}}
                        for name in ["book_search", "book_read_passage"]
                    ]
                }
            else:
                result = {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps({"fragments": [], "schemaVersion": 1}),
                        }
                    ],
                    "isError": False,
                }
            if before_response:
                before_response()
            await self.dispatch(
                "mcp",
                {
                    "topic": self.topic.token,
                    "frames": [{"jsonrpc": "2.0", "id": frame["id"], "result": result}],
                },
            )
        if until_ready and not self.topic.ready:
            await self.pump(True)
        return polled

    async def test_http_auth_shape_and_topic_owner_are_required(self):
        response = await self.client.post("/readweave/v1/open", json={})
        self.assertEqual(response.status_code, 401)
        token = await self.open()
        with self.assertRaises(HTTPException) as result:
            await self.bridge.dispatch(
                "poll", {"topic": token}, "abk_synthetic", "actor_2", "hash_2"
            )
        self.assertEqual(result.exception.status_code, 403)
        response = await self.client.post(
            "/readweave/v1/start",
            json={"topic": token, "bookId": "forged"},
            headers={"Authorization": "Bearer abk_synthetic"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("abk_", response.text)

    async def test_official_client_initializes_and_routes_only_bound_event_tools(self):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": token, "runId": "host_run", "prompt": "wait"}
        )
        await self.api.sending.wait()
        with self.assertRaises(ValueError):
            await self.bridge.call_tool(
                "readweave_book_search",
                "webchat!actor_2!owned_session",
                "backend_run",
                {"query": "x"},
            )
        with self.assertRaises(ValueError):
            await self.bridge.call_tool(
                "readweave_book_search",
                "webchat!actor_1!owned_session",
                "forged_run",
                {"query": "x"},
            )
        call = asyncio.create_task(
            self.bridge.call_tool(
                "readweave_book_search",
                "webchat!actor_1!owned_session",
                "backend_run",
                {"query": "x"},
            )
        )
        await self.pump()
        result = await asyncio.wait_for(call, 5)
        self.assertFalse(result.isError)
        self.active = False
        with self.assertRaises(ValueError):
            await self.bridge.call_tool(
                "readweave_book_search",
                "webchat!actor_1!owned_session",
                "backend_run",
                {"query": "x"},
            )

    async def test_stream_normalization_completion_and_owned_cleanup(self):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": token, "runId": "host_run", "prompt": "answer"}
        )
        await self.topic.run.task
        result = await self.pump()
        self.assertEqual(
            [event["type"] for event in result["events"]], ["text", "reasoning", "done"]
        )
        self.assertEqual([event["sequence"] for event in result["events"]], [1, 2, 3])
        await self.dispatch("close", {"topic": token})
        self.assertIn(("DELETE", "/api/v1/chat/sessions/owned_session"), self.api.calls)
        self.assertNotIn(token, self.bridge.topics)

    async def test_stop_before_output_denies_tools_and_no_late_event_is_emitted(self):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": token, "runId": "host_run", "prompt": "wait"}
        )
        await self.dispatch("cancel", {"topic": token, "runId": "host_run"})
        self.assertTrue(self.topic.run.stopped)
        self.assertIn(
            ("POST", "/api/v1/chat/sessions/owned_session/stop"), self.api.calls
        )
        self.assertTrue(self.topic.events.empty())
        with self.assertRaises(ValueError):
            await self.bridge.call_tool(
                "readweave_book_search",
                "webchat!actor_1!owned_session",
                "backend_run",
                {"query": "x"},
            )

    async def test_followup_reuses_owned_session_with_a_new_run_and_fresh_event_sequence(
        self,
    ):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": token, "runId": "first", "prompt": "answer"}
        )
        await self.topic.run.task
        first = await self.pump()
        first_backend = self.topic.run.backend_id
        await self.dispatch(
            "start", {"topic": token, "runId": "followup", "prompt": "answer"}
        )
        await self.topic.run.task
        second = await self.pump()
        self.assertEqual(self.api.sessions, 1)
        self.assertNotEqual(self.topic.run.backend_id, first_backend)
        self.assertEqual((first["runId"], second["runId"]), ("first", "followup"))
        self.assertEqual(second["events"][0]["sequence"], 1)

    async def test_pending_stop_retires_the_topic_but_does_not_stop_a_new_topic(self):
        first_token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        first = self.topic
        await self.dispatch(
            "start", {"topic": first_token, "runId": "first", "prompt": "answer"}
        )
        await first.run.task
        self.api.stop_gate = asyncio.Event()
        cancelling = asyncio.create_task(
            self.dispatch("cancel", {"topic": first_token, "runId": "first"})
        )
        await self.api.stop_entered.wait()
        with self.assertRaises(HTTPException) as failure:
            await self.dispatch(
                "start",
                {"topic": first_token, "runId": "forbidden", "prompt": "answer"},
            )
        self.assertEqual(failure.exception.status_code, 409)
        next_token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": next_token, "runId": "next", "prompt": "wait"}
        )
        await self.topic.run.backend_ready.wait()
        self.api.stop_gate.set()
        await cancelling
        self.assertFalse(self.topic.run.stopped)
        self.assertEqual(
            [path for method, path in self.api.calls if method == "POST"],
            ["/api/v1/chat/sessions/owned_session/stop"],
        )

    async def test_stop_waits_for_inactive_run_instead_of_accepting_only_the_acknowledgement(
        self,
    ):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": token, "runId": "first", "prompt": "wait"}
        )
        self.api.busy_reads = 1
        await self.dispatch("cancel", {"topic": token, "runId": "first"})
        self.assertEqual(sum(method == "POST" for method, _ in self.api.calls), 2)
        self.assertTrue(self.topic.retired)

    async def test_close_frees_topic_capacity_even_if_upstream_stop_and_delete_fail(
        self,
    ):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        topic = self.topic
        self.api.fail_stop = self.api.fail_delete = True
        with self.assertRaises(ValueError):
            await self.dispatch("close", {"topic": token})
        self.assertNotIn(token, self.bridge.topics)
        self.assertTrue(topic.closed)
        with self.assertRaises(HTTPException) as failure:
            await self.dispatch("poll", {"topic": token})
        self.assertEqual(failure.exception.status_code, 410)

    async def test_queued_tools_and_inflight_results_recheck_authority(self):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": token, "runId": "first", "prompt": "wait"}
        )
        await self.topic.run.backend_ready.wait()
        await self.topic.tool_lock.acquire()
        queued = asyncio.create_task(
            self.bridge.call_tool(
                "readweave_book_search",
                "webchat!actor_1!owned_session",
                "backend_run",
                {"query": "x"},
            )
        )
        await asyncio.sleep(0)
        self.topic.run.finished = True
        self.topic.tool_lock.release()
        with self.assertRaises(ValueError):
            await queued
        self.assertTrue(self.topic.frames.empty())
        self.topic.run.finished = False
        call = asyncio.create_task(
            self.bridge.call_tool(
                "readweave_book_search",
                "webchat!actor_1!owned_session",
                "backend_run",
                {"query": "x"},
            )
        )
        await self.pump(before_response=lambda: setattr(self, "active", False))
        with self.assertRaises(ValueError):
            await call

    async def test_disconnect_expiry_drops_the_old_topic_and_a_new_topic_can_open(self):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": token, "runId": "first", "prompt": "wait"}
        )
        await self.topic.run.backend_ready.wait()
        self.topic.last_seen = time.monotonic() - 46
        await self.bridge.reap_once()
        self.assertNotIn(token, self.bridge.topics)
        replacement = await self.open()
        self.assertNotEqual(replacement, token)

    async def test_stop_during_final_key_check_prevents_returning_tool_data(self):
        token = await self.open()
        await asyncio.wait_for(self.pump(True), 5)
        await self.dispatch(
            "start", {"topic": token, "runId": "first", "prompt": "wait"}
        )
        await self.topic.run.backend_ready.wait()
        checking = asyncio.Event()
        resume = asyncio.Event()
        checks = 0

        async def active(_):
            nonlocal checks
            checks += 1
            if checks == 3:
                checking.set()
                await resume.wait()
            return True

        self.bridge.is_active = active
        call = asyncio.create_task(
            self.bridge.call_tool(
                "readweave_book_search",
                "webchat!actor_1!owned_session",
                "backend_run",
                {"query": "x"},
            )
        )
        await self.pump()
        await asyncio.wait_for(checking.wait(), 5)
        self.topic.run.stopped = True
        resume.set()
        with self.assertRaises(ValueError):
            await call


if __name__ == "__main__":
    unittest.main()
