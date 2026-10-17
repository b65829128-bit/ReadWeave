"""Local contract/security tests. Fake chat events are not external-Harness acceptance."""

import asyncio
import json
import sys
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

    async def request(self, key, method, path):
        self.calls.append((method, path))
        if path.endswith("/new"):
            return {"session_id": "owned_session"}
        return {"stopped_count": 1}

    async def stream(self, key, actor, session, prompt):
        self.sending.set()
        yield {"type": "session_id", "session_id": session}
        yield {"type": "run_started", "data": {"run_id": "backend_run"}}
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

    async def pump(self, until_ready=False):
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


if __name__ == "__main__":
    unittest.main()
