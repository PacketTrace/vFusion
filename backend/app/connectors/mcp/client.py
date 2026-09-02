"""Minimal MCP (Model Context Protocol) client over Streamable HTTP.

Enough of the protocol to browse and drive a remote MCP server from the
UI — no model in the loop. The full exchange is four messages:

    POST initialize                 -> capabilities + instructions,
                                       and an ``Mcp-Session-Id`` response header
    POST notifications/initialized  -> (no response body; completes the handshake)
    POST tools/list                 -> the tool catalog
    POST tools/call                 -> run one tool

Every request after ``initialize`` carries the session id header. Servers
may answer with either ``application/json`` or an SSE stream depending on
the request, so ``_post`` accepts both and unwraps SSE framing when it
sees it.

Auth is a bearer token. Verkada's server accepts either
``Authorization: Bearer <org api key>`` or its own ``x-verkada-api-key``
header; bearer is the interoperable one, so that is what we send.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

import httpx


logger = logging.getLogger(__name__)


# The newest MCP protocol revision this client is written against. These
# are spec revision dates, not build dates — a server reporting an old one
# is speaking an older revision of the protocol, which says nothing about
# when the server itself shipped.
#
# Negotiation: we send our newest, and the server answers with a revision
# it supports. Ask for something it doesn't know and it counters with its
# own latest rather than failing, so the value the UI displays is what the
# two sides actually agreed on — not simply what we asked for.
PROTOCOL_VERSION = "2025-11-25"

DEFAULT_TIMEOUT_SEC = 60.0


class MCPError(RuntimeError):
    """Transport, protocol, or JSON-RPC level failure.

    Note this is *not* raised for a tool that runs and reports a failure —
    that comes back as a normal result with ``isError: true``, which the
    caller renders like any other output.
    """


def _accept_headers(token: str, session_id: str | None) -> dict[str, str]:
    headers = {
        "content-type": "application/json",
        # Both are required by the spec even when the server answers with
        # plain JSON — a server is free to upgrade any response to SSE.
        "accept": "application/json, text/event-stream",
        "authorization": f"Bearer {token}",
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    return headers


def _unwrap(raw: str) -> dict[str, Any]:
    """Parse a response body that may be JSON or an SSE frame.

    SSE bodies arrive as ``event: message\\ndata: {...}`` lines; the JSON-RPC
    payload is the last ``data:`` line.
    """
    text = raw.strip()
    if not text:
        return {}
    if text.startswith("{"):
        return json.loads(text)
    payloads = [
        line[len("data:") :].strip()
        for line in text.splitlines()
        if line.startswith("data:")
    ]
    if not payloads:
        raise MCPError(f"unparseable MCP response: {text[:200]!r}")
    return json.loads(payloads[-1])


@dataclass
class MCPSession:
    """One initialized connection to an MCP server."""

    url: str
    token: str
    session_id: str | None = None
    server_info: dict[str, Any] = field(default_factory=dict)
    capabilities: dict[str, Any] = field(default_factory=dict)
    instructions: str = ""
    protocol_version: str = ""

    _next_id: int = 1

    def _rpc_id(self) -> int:
        current = self._next_id
        self._next_id += 1
        return current


async def _post(
    client: httpx.AsyncClient,
    session: MCPSession,
    body: dict[str, Any],
    *,
    expect_response: bool = True,
) -> tuple[dict[str, Any], httpx.Response]:
    res = await client.post(
        session.url,
        headers=_accept_headers(session.token, session.session_id),
        json=body,
    )
    if res.status_code == 401 or res.status_code == 403:
        raise MCPError(
            "MCP server rejected the credential "
            f"({res.status_code}). Check the API key on the connection."
        )
    if res.status_code >= 400:
        raise MCPError(f"MCP server returned {res.status_code}: {res.text[:200]}")
    if not expect_response:
        return {}, res
    payload = _unwrap(res.text)
    if "error" in payload:
        err = payload["error"]
        raise MCPError(
            f"MCP error {err.get('code', '?')}: {err.get('message', 'unknown')}"
        )
    return payload.get("result", {}), res


async def open_session(
    url: str,
    token: str,
    *,
    client: httpx.AsyncClient,
    client_name: str = "vfusion",
    client_version: str = "0.1",
) -> MCPSession:
    """Run the handshake and return a session ready for tools/* calls."""
    session = MCPSession(url=url, token=token)
    result, res = await _post(
        client,
        session,
        {
            "jsonrpc": "2.0",
            "id": session._rpc_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": client_name, "version": client_version},
            },
        },
    )
    # Header casing varies by server; httpx headers are case-insensitive.
    session.session_id = res.headers.get("mcp-session-id")
    session.server_info = result.get("serverInfo") or {}
    session.capabilities = result.get("capabilities") or {}
    session.instructions = result.get("instructions") or ""
    session.protocol_version = result.get("protocolVersion") or ""

    # Completes the handshake. It's a notification: no id, no response
    # body, and some servers reject later calls without it.
    await _post(
        client,
        session,
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        expect_response=False,
    )
    return session


async def list_tools(
    session: MCPSession, *, client: httpx.AsyncClient
) -> list[dict[str, Any]]:
    """Full tool catalog. Follows ``nextCursor`` pagination to the end."""
    tools: list[dict[str, Any]] = []
    cursor: str | None = None
    # Bounded so a server that returns a repeating cursor can't spin forever.
    for _ in range(20):
        params: dict[str, Any] = {}
        if cursor:
            params["cursor"] = cursor
        result, _ = await _post(
            client,
            session,
            {
                "jsonrpc": "2.0",
                "id": session._rpc_id(),
                "method": "tools/list",
                "params": params,
            },
        )
        tools.extend(result.get("tools") or [])
        cursor = result.get("nextCursor")
        if not cursor:
            break
    return tools


async def call_tool(
    session: MCPSession,
    name: str,
    arguments: dict[str, Any],
    *,
    client: httpx.AsyncClient,
) -> dict[str, Any]:
    """Invoke one tool. Returns the raw result envelope.

    The envelope is ``{"content": [...], "isError": bool}``. Content blocks
    are typed — ``text`` for JSON/prose, ``image`` for base64 frames — so
    the caller renders per block rather than assuming a shape.
    """
    result, _ = await _post(
        client,
        session,
        {
            "jsonrpc": "2.0",
            "id": session._rpc_id(),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    return result


async def describe_server(
    url: str,
    token: str,
    *,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
) -> dict[str, Any]:
    """One-shot: connect, list tools, and return everything the UI needs."""
    async with httpx.AsyncClient(timeout=timeout_sec) as client:
        session = await open_session(url, token, client=client)
        tools = await list_tools(session, client=client)
    return {
        "url": url,
        "requested_protocol_version": PROTOCOL_VERSION,
        "server_info": session.server_info,
        "capabilities": session.capabilities,
        "instructions": session.instructions,
        "protocol_version": session.protocol_version,
        "tools": tools,
    }
