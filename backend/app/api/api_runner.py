"""Run any Verkada endpoint against a connection you already hold.

The catalog knows every endpoint and its parameters; the client knows
how to authenticate. This is the small piece between them — resolve a
path, send it, hand back what came off the wire.

Deliberately thin. It does not validate the request against the spec
beyond filling path placeholders: the point of a runner is to see what
the API actually does, including what it does with a request the schema
would have rejected. Guessing on the operator's behalf would hide the
answer they came for.

Two things it does insist on. The method is echoed back with the
resolved URL, so what ran is never in doubt when a result is
surprising. And non-GET calls are flagged as writes, because "try it
and see" against an org that can unlock doors deserves to be a
different-looking action than reading a camera list.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.client import VerkadaClient
from app.crypto import decrypt_secret
from app.db import get_session
from app.models import Connection


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/api-runner", tags=["api-runner"])

# Anything that is not a read. Kept as a set rather than "not GET" so a
# HEAD or OPTIONS does not get dressed up as dangerous.
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

_PLACEHOLDER = re.compile(r"\{([^}]+)\}")


class TokenRequest(BaseModel):
    connection_id: UUID | None = None


class RunRequest(BaseModel):
    connection_id: UUID | None = None
    # A token from /token. When present the call uses it directly
    # instead of exchanging the key again, so what the runner shows and
    # what it sends are the same thing.
    token: str | None = None
    method: str = "GET"
    path: str
    # Values for {placeholders} in the path.
    path_params: dict[str, str] = {}
    query: dict[str, Any] = {}
    json_body: Any = None


def resolve_path(path: str, params: dict[str, str]) -> tuple[str, list[str]]:
    """Substitute {placeholders}. Returns (path, names still missing).

    Unfilled placeholders are reported rather than sent: a literal
    ``{camera_id}`` in a URL comes back as a 403 from Verkada, which
    reads as a permissions problem and is not one.
    """
    missing: list[str] = []

    def sub(m: re.Match[str]) -> str:
        name = m.group(1)
        value = params.get(name)
        if value is None or value == "":
            missing.append(name)
            return m.group(0)
        return str(value)

    return _PLACEHOLDER.sub(sub, path), missing


async def _connection(session: AsyncSession, conn_id: UUID | None) -> Connection:
    conn = None
    if conn_id:
        conn = await session.get(Connection, conn_id)
    if conn is None:
        conn = (
            await session.execute(
                select(Connection)
                .where(Connection.type == "verkada")
                .order_by(Connection.created_at.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if conn is None or conn.type != "verkada":
        raise HTTPException(
            status_code=400,
            detail="No Verkada connection configured — add one on the Connections page.",
        )
    return conn


@router.post("/token")
async def get_token(
    body: TokenRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Trade the org's API key for a short-lived token.

    Verkada's API is two calls: POST /token with the key, then every
    request carrying the token in x-verkada-auth. vFusion normally does
    the first one invisibly, which is right everywhere except here — on
    a page for understanding the API, a hidden step is the one you
    cannot debug. A 401 on the exchange and a 401 on the call mean
    completely different things.
    """
    conn = await _connection(session, body.connection_id)
    try:
        secret = decrypt_secret(conn.encrypted_secret) or {}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decrypt secret: {e}") from e
    api_key = secret.get("api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="That connection has no API key.")

    client = VerkadaClient(api_key=api_key, base_url=secret.get("region") or None)
    started = time.monotonic()
    try:
        body = await client.login_raw()
        token = str(body.get("token") or "")
    except Exception as e:  # noqa: BLE001
        return {
            "ok": False,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "error": str(e),
        }
    return {
        "ok": True,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "endpoint": f"{client.base_url}/token",
        "sent_header": "x-api-key",
        "use_header": "x-verkada-auth",
        # Short-lived and scoped to the same access the key already has.
        # Returned because the point of this page is to show the
        # exchange; the UI keeps it masked until asked.
        "token": token,
        "connection": conn.name,
        "issued_at": time.time(),
        # Whatever the response carries about lifetime, verbatim and
        # unnamed on our side. Verkada documents these tokens as
        # short-lived without the API always saying how short, so the
        # UI counts down when there is something to count and says how
        # old the token is when there is not — rather than inventing a
        # number that would be wrong on the day it changes.
        "expires_in": body.get("expires_in"),
        "expires_at": body.get("expires_at") or body.get("expiry"),
        "raw": {k: v for k, v in body.items() if k != "token"},
    }


@router.post("/run")
async def run(
    body: RunRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    conn = None
    if body.connection_id:
        conn = await session.get(Connection, body.connection_id)
    if conn is None:
        conn = (
            await session.execute(
                select(Connection)
                .where(Connection.type == "verkada")
                .order_by(Connection.created_at.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if conn is None or conn.type != "verkada":
        raise HTTPException(
            status_code=400,
            detail="No Verkada connection configured — add one on the Connections page.",
        )
    try:
        api_key = (decrypt_secret(conn.encrypted_secret) or {}).get("api_key")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decrypt secret: {e}") from e
    if not api_key:
        raise HTTPException(status_code=400, detail="That connection has no API key.")

    path, missing = resolve_path(body.path, body.path_params)
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Fill in {', '.join(missing)} before running this.",
        )

    method = body.method.upper()
    client = VerkadaClient(
        api_key=api_key,
        base_url=(decrypt_secret(conn.encrypted_secret) or {}).get("region") or None,
        # Reuses the token the page is showing when there is one, so the
        # request the runner describes is the request it makes.
        token=body.token or None,
    )

    # Empty query values are dropped rather than sent blank. An empty
    # string is a filter that matches nothing on most endpoints, which
    # looks identical to "there is no data" in the response.
    query = {k: v for k, v in (body.query or {}).items() if v not in (None, "")}

    started = time.monotonic()
    try:
        result = await client.request(
            method=method,
            path=path,
            query=query or None,
            json_body=body.json_body if method in WRITE_METHODS else None,
        )
    except Exception as e:  # noqa: BLE001
        # A transport failure is a result too — the operator wants to see
        # it next to the request, not as a red toast with no context.
        return {
            "ok": False,
            "method": method,
            "path": path,
            "query": query,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "error": str(e),
        }
    elapsed = round((time.monotonic() - started) * 1000)
    status = int(result.get("status_code") or 0)
    return {
        "ok": 200 <= status < 300,
        "method": method,
        "path": path,
        "query": query,
        "status_code": status,
        "elapsed_ms": elapsed,
        "body": result.get("body"),
        "is_write": method in WRITE_METHODS,
    }
