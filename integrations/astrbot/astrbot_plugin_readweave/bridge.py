"""Loopback relay. No book identifiers or authority are accepted from model arguments."""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import anyio
import httpx
from fastapi import FastAPI, HTTPException, Request
from mcp import ClientSession
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage

MAX_FRAME = 256 * 1024
IDENTIFIER = re.compile(r"^[a-zA-Z0-9_-]{1,160}$")
TOOLS = {
    "readweave_book_search": "book_search",
    "readweave_book_read_passage": "book_read_passage",
}


class ChatApi:
    """Only call the fixed local AstrBot API; the key is supplied by the current request."""

    def __init__(self, base: str = "http://127.0.0.1:6185"):
        self.base = base

    def client(self, key: str):
        return httpx.AsyncClient(
            base_url=self.base,
            headers={"Authorization": f"Bearer {key}"},
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(30, read=300),
        )

    async def request(self, key: str, method: str, path: str) -> dict:
        async with self.client(key) as client:
            response = await client.request(method, path)
            response.raise_for_status()
            payload = response.json()
            if payload.get("status") != "ok":
                raise ValueError("AstrBot rejected the session operation")
            return payload.get("data") or {}

    async def stream(self, key: str, actor: str, session: str, prompt: str):
        async with (
            self.client(key) as client,
            client.stream(
                "POST",
                "/api/v1/chat",
                json={
                    "username": actor,
                    "session_id": session,
                    "message": prompt,
                },
            ) as response,
        ):
            response.raise_for_status()
            if "text/event-stream" not in response.headers.get("content-type", ""):
                raise ValueError("AstrBot did not start an event stream")
            async for line in response.aiter_lines():
                if len(line.encode()) > MAX_FRAME:
                    raise ValueError("Oversized AstrBot event")
                if line.startswith("data:"):
                    yield json.loads(line[5:])


@dataclass
class Run:
    host_id: str
    backend_id: str | None = None
    sequence: int = 0
    stopped: bool = False
    finished: bool = False
    backend_ready: asyncio.Event = field(default_factory=asyncio.Event)
    queued: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


@dataclass
class Topic:
    token: str
    actor: str
    key_hash: str
    session: str
    last_seen: float = field(default_factory=time.monotonic)
    ready: bool = False
    closed: bool = False
    retired: bool = False
    run: Run | None = None
    client: ClientSession | None = None
    incoming: Any = None
    mcp_task: asyncio.Task | None = None
    stopped: asyncio.Event = field(default_factory=asyncio.Event)
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    frames: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(16))
    events: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(128))
    poll_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    tool_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    control_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class Bridge:
    def __init__(
        self,
        authenticate: Callable[[str], Awaitable[tuple[str, str]]],
        is_active: Callable[[str], Awaitable[bool]],
        api: ChatApi | None = None,
    ):
        self.authenticate = authenticate
        self.is_active = is_active
        self.api = api or ChatApi()
        self.topics: dict[str, Topic] = {}
        self.open_lock = asyncio.Lock()
        self.app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
        self.app.add_api_route("/readweave/v1/{action}", self.handle, methods=["POST"])

    async def handle(self, action: str, request: Request):
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(415, "JSON required")
        key = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not key.startswith("abk_") or len(key) > 8192:
            raise HTTPException(401, "API key required")
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 1024 * 1024:
                raise HTTPException(413, "Request too large")
        try:
            body = json.loads(data)
            if not isinstance(body, dict):
                raise TypeError()
            actor, key_hash = await self.authenticate(key)
            return await self.dispatch(action, body, key, actor, key_hash)
        except HTTPException:
            raise
        except (ValueError, TypeError, KeyError):
            raise HTTPException(400, "Invalid bridge request") from None
        except Exception:  # noqa: BLE001 -- Redact all upstream errors at the HTTP boundary.
            # Never return exception strings: upstream exceptions may contain request data.
            raise HTTPException(502, "Bridge operation failed") from None

    async def dispatch(
        self, action: str, body: dict, key: str, actor: str, key_hash: str
    ):
        shapes = {
            "open": set(),
            "start": {"topic", "runId", "prompt"},
            "poll": {"topic"},
            "mcp": {"topic", "frames"},
            "cancel": {"topic", "runId"},
            "close": {"topic"},
        }
        if action not in shapes or set(body) != shapes[action]:
            raise ValueError()
        if action == "open":
            async with self.open_lock:
                if len(self.topics) >= 4:
                    raise HTTPException(409, "Topic limit reached")
                data = await self.api.request(key, "GET", "/api/v1/chat/sessions/new")
                session = data["session_id"]
                if not isinstance(session, str) or not IDENTIFIER.fullmatch(session):
                    raise ValueError()
                topic = Topic(secrets.token_urlsafe(32), actor, key_hash, session)
                self.topics[topic.token] = topic
                topic.mcp_task = asyncio.create_task(self.connect_mcp(topic))
                return {"topic": topic.token, "version": "4.27.4"}
        topic = (
            self.topics.get(body["topic"]) if isinstance(body["topic"], str) else None
        )
        if not topic or topic.closed:
            raise HTTPException(410, "Topic unavailable")
        if topic.actor != actor or topic.key_hash != key_hash:
            raise HTTPException(403, "Topic unavailable")
        topic.last_seen = time.monotonic()
        if action == "poll":
            if topic.poll_lock.locked():
                raise HTTPException(409, "Poll already active")
            async with topic.poll_lock:
                topic.wake.clear()
                if topic.frames.empty() and topic.events.empty():
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(topic.wake.wait(), 15)
                frames, events = [], []
                while len(frames) < 8 and not topic.frames.empty():
                    frames.append(topic.frames.get_nowait())
                while len(events) < 64 and not topic.events.empty():
                    events.append(topic.events.get_nowait())
                return {
                    "ready": topic.ready,
                    "frames": frames,
                    "events": events,
                    "runId": topic.run.host_id if topic.run else None,
                }
        if action == "mcp":
            frames = body["frames"]
            if (
                not isinstance(frames, list)
                or not 1 <= len(frames) <= 8
                or topic.incoming is None
            ):
                raise ValueError()
            messages = []
            for frame in frames:
                if len(json.dumps(frame).encode()) > MAX_FRAME:
                    raise ValueError()
                messages.append(SessionMessage(JSONRPCMessage.model_validate(frame)))
            for message in messages:
                await asyncio.wait_for(topic.incoming.send(message), 5)
        elif action == "start":
            if topic.retired or not topic.ready or topic.run and not topic.run.finished:
                raise HTTPException(409, "Topic is busy or not ready")
            if not isinstance(body["runId"], str) or not IDENTIFIER.fullmatch(
                body["runId"]
            ):
                raise ValueError()
            if (
                not isinstance(body["prompt"], str)
                or not 1 <= len(body["prompt"]) <= 100_000
            ):
                raise ValueError()
            while not topic.events.empty():
                topic.events.get_nowait()
            run = Run(body["runId"])
            topic.run = run
            run.task = asyncio.create_task(
                self.generate(topic, run, key, body["prompt"])
            )
        elif action == "cancel":
            if topic.run and topic.run.host_id != body["runId"]:
                raise HTTPException(409, "Run mismatch")
            await self.cancel(topic, key)
        elif action == "close":
            await self.close_topic(topic, key)
        return {"ok": True}

    async def connect_mcp(self, topic: Topic):
        to_client, from_host = anyio.create_memory_object_stream(16)
        to_host, from_client = anyio.create_memory_object_stream(16)
        topic.incoming = to_client

        async def forward():
            async with from_client:
                async for message in from_client:
                    frame = message.message.model_dump(
                        mode="json", by_alias=True, exclude_none=True
                    )
                    if len(json.dumps(frame).encode()) > MAX_FRAME:
                        raise ValueError("Oversized MCP frame")
                    await topic.frames.put(frame)
                    topic.wake.set()

        try:
            async with (
                to_client,
                from_host,
                to_host,
                asyncio.TaskGroup() as tasks,
            ):
                worker = tasks.create_task(forward())
                async with ClientSession(from_host, to_host) as client:
                    topic.client = client
                    await asyncio.wait_for(client.initialize(), 30)
                    listed = await asyncio.wait_for(client.list_tools(), 15)
                    if {tool.name for tool in listed.tools} != set(TOOLS.values()):
                        raise ValueError("Unexpected reading tools")
                    topic.ready = True
                    topic.wake.set()
                    await topic.stopped.wait()
                worker.cancel()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 -- Fail closed on any protocol worker error.
            topic.ready = False
            topic.closed = True
            topic.wake.set()
        finally:
            topic.client = None

    async def emit(self, topic: Topic, run: Run, event: dict):
        if run.stopped or topic.closed:
            return
        run.sequence += 1
        await topic.events.put({**event, "sequence": run.sequence})
        topic.wake.set()

    async def generate(self, topic: Topic, run: Run, key: str, prompt: str):
        ended = False
        text_size = reasoning_size = 0
        try:
            if run.stopped:
                return
            async for event in self.api.stream(key, topic.actor, topic.session, prompt):
                kind = event.get("type")
                if kind == "session_id":
                    run.queued.set()
                if run.stopped:
                    continue
                if kind == "run_started":
                    backend = event["data"]["run_id"]
                    if not isinstance(backend, str) or not IDENTIFIER.fullmatch(
                        backend
                    ):
                        raise ValueError()
                    run.backend_id = backend
                    run.backend_ready.set()
                elif kind == "plain":
                    chain = event.get("chain_type")
                    if chain in ("tool_call", "tool_call_result"):
                        continue
                    delta = event.get("data")
                    if not isinstance(delta, str):
                        raise ValueError()
                    reasoning = chain == "reasoning"
                    if reasoning:
                        reasoning_size += len(delta)
                    else:
                        text_size += len(delta)
                    if text_size > 64_000 or reasoning_size > 256_000:
                        raise ValueError()
                    await self.emit(
                        topic,
                        run,
                        {"type": "reasoning" if reasoning else "text", "delta": delta},
                    )
                elif kind == "error":
                    raise ValueError()
                elif kind == "end":
                    ended = True
            if not run.stopped:
                if not ended:
                    raise ValueError("Missing final event")
                await self.emit(topic, run, {"type": "done"})
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 -- Send a redacted failure and stop upstream execution.
            await self.emit(topic, run, {"type": "error"})
            with contextlib.suppress(Exception):
                await self.api.request(
                    key, "POST", f"/api/v1/chat/sessions/{topic.session}/stop"
                )
        finally:
            run.finished = True
            run.queued.set()
            run.backend_ready.set()

    async def call_tool(self, name: str, session: str, message: str, arguments: dict):
        topic = next(
            (
                item
                for item in self.topics.values()
                if session == f"webchat!{item.actor}!{item.session}"
            ),
            None,
        )
        if not topic or name not in TOOLS:
            raise ValueError("No approved reading task for this conversation")
        run = topic.run
        if run and not run.backend_id:
            await asyncio.wait_for(run.backend_ready.wait(), 3)
        if (
            not run
            or run.backend_id != message
            or not await self.tool_authorized(topic, run)
        ):
            raise ValueError("Reading task is unavailable")
        async with topic.tool_lock:
            if not await self.tool_authorized(topic, run):
                raise ValueError("Reading task is unavailable")
            # MCP peer identity is fixed by the host; arguments cannot select another grant.
            result = await asyncio.wait_for(
                topic.client.call_tool(TOOLS[name], arguments), 30
            )
            if not await self.tool_authorized(topic, run):
                raise ValueError("Reading task is unavailable")
            return result

    async def tool_authorized(self, topic: Topic, run: Run) -> bool:
        active = await self.is_active(topic.key_hash)
        # Recheck mutable state after the database await, including before returning data.
        return bool(
            active
            and topic.ready
            and topic.client is not None
            and not topic.closed
            and not topic.retired
            and topic.run is run
            and not run.stopped
            and not run.finished
            and time.monotonic() - topic.last_seen <= 45
        )

    async def cancel(self, topic: Topic, key: str):
        # A cancelled topic is terminal, including while its upstream stop is pending.
        topic.retired = True
        if topic.run:
            topic.run.stopped = True
        async with topic.control_lock:
            if topic.closed:
                return
            await self.stop_upstream(topic, key)

    async def stop_upstream(self, topic: Topic, key: str):
        run = topic.run
        try:
            async with asyncio.timeout(10):
                if run:
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(run.queued.wait(), 5)
                while True:
                    await self.api.request(
                        key, "POST", f"/api/v1/chat/sessions/{topic.session}/stop"
                    )
                    state = await self.api.request(
                        key, "GET", f"/api/v1/chat/sessions/{topic.session}"
                    )
                    # An HTTP acknowledgement alone does not prove a run has stopped.
                    if (
                        state.get("is_running") is False
                        and state.get("active_runs") == []
                    ):
                        return
                    await asyncio.sleep(0.2)
        finally:
            if run and run.task and not run.task.done():
                run.task.cancel()
                await asyncio.gather(run.task, return_exceptions=True)

    async def close_topic(self, topic: Topic, key: str):
        topic.retired = True
        if topic.run:
            topic.run.stopped = True
        async with topic.control_lock:
            if topic.closed:
                return
            try:
                # Deletion is also attempted if the stop acknowledgement fails.
                with contextlib.suppress(Exception):
                    await self.stop_upstream(topic, key)
                await asyncio.wait_for(
                    self.api.request(
                        key, "DELETE", f"/api/v1/chat/sessions/{topic.session}"
                    ),
                    5,
                )
            finally:
                # Free local capacity even when the upstream session needs manual cleanup.
                await self.remove(topic)

    async def remove(self, topic: Topic):
        topic.closed = True
        topic.retired = True
        topic.stopped.set()
        topic.wake.set()
        if topic.run:
            topic.run.stopped = True
            if topic.run.task:
                topic.run.task.cancel()
                await asyncio.gather(topic.run.task, return_exceptions=True)
        if topic.mcp_task:
            topic.mcp_task.cancel()
            await asyncio.gather(topic.mcp_task, return_exceptions=True)
        self.topics.pop(topic.token, None)

    async def reap(self):
        while True:
            await asyncio.sleep(10)
            await self.reap_once()

    async def reap_once(self):
        for topic in list(self.topics.values()):
            active = topic.run and not topic.run.finished
            if topic.closed or time.monotonic() - topic.last_seen > (
                45 if active else 600
            ):
                # No raw key is retained for cleanup. Deny tools and drop subscriptions;
                # model execution may continue upstream until its own timeout.
                await self.remove(topic)

    async def close(self):
        for topic in list(self.topics.values()):
            await self.remove(topic)
