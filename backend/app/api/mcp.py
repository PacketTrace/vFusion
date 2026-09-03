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

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.mcp import MCPError, describe_server
from app.connectors.mcp.history import record as record_history
from app.connectors.verkada.client import normalize_base_url
from app.crypto import decrypt_secret
from app.db import get_session
from app.models import Connection


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


# The catalog is ~140KB and changes about as often as Verkada ships, so a
# short in-process TTL keeps the page snappy. This is a response cache
# only — connectors/mcp/history.py holds the durable part.
# Keyed by (connection_id, url). Cleared by ?refresh=true.
_CATALOG_TTL_SEC = 900
_catalog_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}

# The in-process cache dies with the process, so the first visit after a
# redeploy pays for a full round trip — initialize, then tools/list
# paginated over 135 tools — while the page sits empty for a few seconds.
# A copy on disk survives restarts, so that visit renders immediately
# from the last known catalog and the refresh happens behind it.
_SNAPSHOT_PATH = Path(
    os.environ.get("MCP_CATALOG_FILE", "/app/data/mcp/catalog.json")
)
_refreshing: set[tuple[str, str]] = set()


def _snapshot_load(key: tuple[str, str]) -> dict[str, Any] | None:
    try:
        data = json.loads(_SNAPSHOT_PATH.read_text())
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("mcp catalog snapshot unreadable: %s", e)
        return None
    entry = data.get("|".join(key)) if isinstance(data, dict) else None
    return entry if isinstance(entry, dict) else None


def _snapshot_save(key: tuple[str, str], payload: dict[str, Any]) -> None:
    try:
        _SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
        try:
            data = json.loads(_SNAPSHOT_PATH.read_text())
            if not isinstance(data, dict):
                data = {}
        except (OSError, json.JSONDecodeError):
            data = {}
        data["|".join(key)] = payload
        tmp = _SNAPSHOT_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(_SNAPSHOT_PATH)
    except OSError as e:
        logger.warning("could not persist mcp catalog: %s", e)


async def _fetch_catalog(
    conn_id: str, conn_name: str, url: str, token: str
) -> dict[str, Any]:
    """Live fetch + history annotation. No DB session needed, so this can
    run detached from the request that triggered it."""
    described = await describe_server(url, token)
    history = await record_history(url, described.get("tools") or [])
    catalog_bytes = len(json.dumps(described.get("tools") or []))
    payload = {
        **described,
        **history,
        "catalog_bytes": catalog_bytes,
        "catalog_tokens_estimate": catalog_bytes // 4,
        "connection_id": conn_id,
        "connection_name": conn_name,
        "fetched_at": time.time(),
    }
    key = (conn_id, url)
    _catalog_cache[key] = (time.monotonic(), payload)
    _snapshot_save(key, payload)
    return payload


async def _refresh_in_background(
    key: tuple[str, str], conn_id: str, conn_name: str, url: str, token: str
) -> None:
    if key in _refreshing:
        return
    _refreshing.add(key)
    try:
        await _fetch_catalog(conn_id, conn_name, url, token)
    except Exception as e:  # noqa: BLE001 — nobody is waiting on this
        logger.info("background mcp refresh failed: %s", e)
    finally:
        _refreshing.discard(key)


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
        # Nothing in memory — most likely a restart. Render what we had
        # last time and go get a fresh copy without making anyone wait.
        stale = _snapshot_load(key)
        if stale:
            asyncio.create_task(
                _refresh_in_background(key, str(conn.id), conn.name, url, token)
            )
            return {**stale, "cached": True, "stale": True}
    try:
        payload = await _fetch_catalog(str(conn.id), conn.name, url, token)
    except MCPError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001 — network/DNS/TLS
        raise HTTPException(status_code=502, detail=f"could not reach {url}: {e}")
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
