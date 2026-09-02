"""MCP explorer — browse and drive a remote MCP server from the UI.

No model in the loop. This is the MCP-shaped sibling of the API Catalog
page: the catalog page reads Verkada's OpenAPI specs and generates a form
per REST endpoint; this reads an MCP server's ``tools/list`` and generates
a form per tool.

Auth reuses the Verkada connection the operator already configured — the
same org API key works as an MCP bearer token, so an existing vFusion
install needs no new credential to use this.
"""

from __future__ import annotations

import logging
import time
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.mcp import MCPError, describe_server
from app.connectors.verkada.client import normalize_base_url
from app.crypto import decrypt_secret
from app.db import get_session
from app.models import Connection


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


# The catalog is ~140KB and changes about as often as Verkada ships, so a
# short in-process TTL keeps the page snappy without a table + migration.
# Keyed by (connection_id, url). Cleared by ?refresh=true.
_CATALOG_TTL_SEC = 900
_catalog_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


def _mcp_url_for(secret: dict[str, Any]) -> str:
    """Derive the MCP endpoint from the connection's region.

    Verkada serves MCP at ``/mcp`` on the same regional host as the REST
    API, so an EU org's connection points at the EU MCP automatically.
    """
    return f"{normalize_base_url(secret.get('region') or None)}/mcp"


async def _resolve(
    session: AsyncSession, conn_id: UUID | None
) -> tuple[Connection, str, str]:
    """Return (connection, mcp_url, token) for the requested or only org."""
    if conn_id is not None:
        conn = await session.get(Connection, conn_id)
        if conn is None or conn.type != "verkada":
            raise HTTPException(status_code=404, detail="Verkada connection not found")
    else:
        conn = (
            await session.execute(
                select(Connection)
                .where(Connection.type == "verkada", Connection.setup_complete.is_(True))
                .order_by(Connection.created_at.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if conn is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No configured Verkada connection. Add one on the "
                    "Connections page first — the MCP explorer signs in with "
                    "that same org API key."
                ),
            )
    try:
        secret = decrypt_secret(conn.encrypted_secret)
    except Exception as e:  # noqa: BLE001 — surfaced to the operator as 400
        raise HTTPException(status_code=400, detail=f"could not decrypt secret: {e}")
    token = secret.get("api_key")
    if not token:
        raise HTTPException(
            status_code=400,
            detail="That connection has no API key yet — finish setup first.",
        )
    return conn, _mcp_url_for(secret), token


async def _catalog(
    session: AsyncSession, conn_id: UUID | None, refresh: bool
) -> dict[str, Any]:
    conn, url, token = await _resolve(session, conn_id)
    key = (str(conn.id), url)
    now = time.monotonic()
    if not refresh:
        hit = _catalog_cache.get(key)
        if hit and now - hit[0] < _CATALOG_TTL_SEC:
            return {**hit[1], "cached": True}
    try:
        described = await describe_server(url, token)
    except MCPError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001 — network/DNS/TLS
        raise HTTPException(status_code=502, detail=f"could not reach {url}: {e}")
    payload = {
        **described,
        "connection_id": str(conn.id),
        "connection_name": conn.name,
        "fetched_at": time.time(),
    }
    _catalog_cache[key] = (now, payload)
    return {**payload, "cached": False}


@router.get("/catalog")
async def get_catalog(
    connection_id: UUID | None = None,
    refresh: bool = False,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Server identity, its instructions, and the full tool catalog."""
    return await _catalog(session, connection_id, refresh)


class CallRequest(BaseModel):
    connection_id: UUID | None = None
    name: str
    arguments: dict[str, Any] = {}
    # Tools the server annotates ``destructiveHint: true`` change the
    # customer's physical security posture (unlock a door, delete a user,
    # revoke a credential). Require an explicit opt-in per call so a
    # mis-click in a generated form can't do that quietly.
    confirm_destructive: bool = False


@router.post("/call")
async def call(
    payload: CallRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Invoke one tool and return its raw result envelope."""
    catalog = await _catalog(session, payload.connection_id, refresh=False)
    tool = next(
        (t for t in catalog.get("tools", []) if t.get("name") == payload.name), None
    )
    if tool is None:
        raise HTTPException(
            status_code=404, detail=f"{payload.name} is not in this server's catalog"
        )
    annotations = tool.get("annotations") or {}
    if annotations.get("destructiveHint") and not payload.confirm_destructive:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{payload.name} is marked destructive by the server. "
                "Re-send with confirm_destructive to run it."
            ),
        )

    import httpx

    from app.connectors.mcp.client import call_tool, open_session

    _, url, token = await _resolve(session, payload.connection_id)
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            mcp = await open_session(url, token, client=client)
            result = await call_tool(
                mcp, payload.name, payload.arguments, client=client
            )
    except MCPError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001 — network/DNS/TLS
        raise HTTPException(status_code=502, detail=f"MCP call failed: {e}")
    return {
        "name": payload.name,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
        "result": result,
    }
