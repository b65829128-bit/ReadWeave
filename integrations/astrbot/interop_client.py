"""Explicit integration test: official Python MCP client against the real Rust core."""

import json
import sys

import anyio
from mcp import ClientSession
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage


async def main():
    incoming, reader = anyio.create_memory_object_stream(16)
    writer, outgoing = anyio.create_memory_object_stream(16)

    async def receive():
        while line := await anyio.to_thread.run_sync(
            sys.stdin.buffer.readline, abandon_on_cancel=True
        ):
            await incoming.send(
                SessionMessage(JSONRPCMessage.model_validate_json(line))
            )

    async def send():
        async for message in outgoing:
            sys.stdout.buffer.write(
                message.message.model_dump_json(
                    by_alias=True, exclude_none=True
                ).encode()
                + b"\n"
            )
            sys.stdout.buffer.flush()

    async with anyio.create_task_group() as group:
        group.start_soon(receive)
        group.start_soon(send)
        async with ClientSession(reader, writer) as client:
            await client.initialize()
            tools = await client.list_tools()
            assert {tool.name for tool in tools.tools} == {
                "book_search",
                "book_read_passage",
            }
            for tool in tools.tools:
                assert tool.inputSchema["additionalProperties"] is False
                assert not {"bookId", "runId", "scope"}.intersection(
                    tool.inputSchema["properties"]
                )
            result = await client.call_tool("book_search", {"query": "丞相"})
            assert not result.isError
            data = json.loads(result.content[0].text)
            assert data["fragments"]
            assert all(
                "后文秘密" not in fragment["text"] for fragment in data["fragments"]
            )
            passage = await client.call_tool(
                "book_read_passage", {"ref": data["fragments"][0]["ref"]}
            )
            assert not passage.isError
            hidden = await client.call_tool("book_search", {"query": "秘密"})
            assert not json.loads(hidden.content[0].text)["fragments"]
            forged = await client.call_tool(
                "book_search", {"query": "秘密", "scope": "book"}
            )
            assert forged.isError
        group.cancel_scope.cancel()


anyio.run(main)
