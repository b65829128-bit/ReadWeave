import asyncio
import contextlib
import json
import socket
from pathlib import Path

import uvicorn
from astrbot import __version__
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.tool import FunctionTool
from astrbot.core.workspace import API_KEY_USERNAME_PREFIX
from astrbot.dashboard.services.api_key_service import ApiKeyService
from fastapi import HTTPException

from .bridge import Bridge


class ReadingTool(FunctionTool):
    async def call(self, context, **kwargs):
        event = context.context.event
        try:
            return await self._bridge.call_tool(
                self.name,
                event.message_obj.session_id,
                event.message_obj.message_id,
                kwargs,
            )
        except Exception:
            return json.dumps(
                {
                    "error": {
                        "code": "READWEAVE_UNAVAILABLE",
                        "message": "本会话没有可用的 ReadWeave 阅读授权。",
                    }
                },
                ensure_ascii=False,
            )


@register(
    "readweave",
    "ReadWeave",
    "ReadWeave 本机授权阅读桥接（固定 AstrBot 4.27.4）",
    "0.1.0",
)
class ReadWeavePlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.server = None
        self.worker = None
        self.gc = None
        self.bridge = None
        self.listener = None

    async def initialize(self):
        if __version__.removeprefix("v") != "4.27.4":
            raise RuntimeError("ReadWeave requires AstrBot 4.27.4")
        db = self.context.get_db()

        async def authenticate(raw):
            key_hash = await asyncio.to_thread(ApiKeyService.hash_key, raw)
            key = await db.get_active_api_key_by_hash(key_hash)
            if key is None:
                raise HTTPException(401, "Invalid API key")
            if "chat" not in (key.scopes or []) and "*" not in (key.scopes or []):
                raise HTTPException(403, "chat scope required")
            return f"{API_KEY_USERNAME_PREFIX}{key.key_id}", key_hash

        async def is_active(key_hash):
            key = await db.get_active_api_key_by_hash(key_hash)
            return key is not None and bool(
                {"chat", "*"}.intersection(key.scopes or [])
            )

        self.bridge = Bridge(authenticate, is_active)
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self.listener.bind(("127.0.0.1", 6186))
            self.listener.listen(128)
            self.listener.setblocking(False)
            self.server = uvicorn.Server(
                uvicorn.Config(
                    self.bridge.app,
                    host="127.0.0.1",
                    port=6186,
                    access_log=False,
                    log_level="critical",
                )
            )
            # The sidecar must not install signal handlers in the AstrBot process.
            self.server.capture_signals = contextlib.nullcontext
            self.worker = asyncio.create_task(
                self.server.serve(sockets=[self.listener])
            )
            for _ in range(100):
                if self.server.started:
                    break
                if self.worker.done():
                    await self.worker
                    raise RuntimeError("ReadWeave bridge failed to start")
                await asyncio.sleep(0.02)
            if not self.server.started:
                raise RuntimeError("ReadWeave bridge startup timed out")
            self.gc = asyncio.create_task(self.bridge.reap())
            definitions = json.loads(
                Path(__file__).with_name("reading-tools.json").read_text("utf-8")
            )
            for item in definitions:
                definition = item["function"]
                tool = ReadingTool(
                    name="readweave_" + definition["name"],
                    description=definition["description"],
                    parameters=definition["parameters"],
                )
                tool._bridge = self.bridge
                self.context.add_llm_tools(tool)
        except BaseException:
            await self.terminate()
            raise

    async def terminate(self):
        if self.bridge:
            await self.bridge.close()
        if self.gc:
            self.gc.cancel()
            await asyncio.gather(self.gc, return_exceptions=True)
        if self.server:
            self.server.should_exit = True
        if self.worker:
            try:
                await asyncio.wait_for(self.worker, 5)
            except TimeoutError:
                self.worker.cancel()
                await asyncio.gather(self.worker, return_exceptions=True)
        if self.listener:
            self.listener.close()
