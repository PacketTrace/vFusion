"""What is actually on Verkada right now.

Everything else on the Helix page is our own view of the world: types we
synced, events a flow believes it posted. This asks Verkada instead. It
is the difference between "the run said HTTP 200" and "the event is
there", and those come apart more often than you would like -- a flow
that posts to a deleted type, a time_ms in milliseconds when it should
have been seconds, an attribute Helix truncated.

**The path is looked up, not hard-coded.** vFusion already crawls
Verkada's OpenAPI specs into ``verkada_api_endpoints``; the search
operation is found there by matching the video_tagging paths. Verkada
answers an unknown path with 403 -- the same status as a missing scope --
so a guessed path fails in a way that reads like a permissions problem
and sends you looking in the wrong place entirely. Resolving from the
spec means we either use the real path or say plainly that we could not
find it.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.client import VerkadaApiError, VerkadaClient
from app.crypto import decrypt_secret
from app.db import get_session
from app.models import Connection, VerkadaApiEndpoint


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/helix-published", tags=["helix-published"])

# Tried in order when the crawled catalog has nothing to offer — a fresh
# deploy has not run the crawl yet, and the page should still work.
FALLBACK_CANDIDATES: list[tuple[str, str]] = [
    ("POST", "/cameras/v1/video_tagging/event/search"),
    ("GET", "/cameras/v1/video_tagging/event"),
]


class PublishedEvent(BaseModel):
    camera_id: str | None = None
    event_type_uid: str | None = None
    time_ms: int | None = None
    flagged: bool = False
    attributes: dict[str, Any] = {}


class PublishedResponse(BaseModel):
    events: list[PublishedEvent]
    next_token: Any = None
    # Which call produced this, so a wrong guess is visible rather than
    # looking like an empty org.
    path_used: str
    method_used: str
    source: str  # "catalog" | "fallback"


async def _resolve_search_op(session: AsyncSession) -> tuple[str, str, str]:
    """(method, path, source) for the Helix event search."""
    rows = (
        (
            await session.execute(
                select(VerkadaApiEndpoint).where(
                    VerkadaApiEndpoint.path.like("%video_tagging%")
                )
            )
        )
        .scalars()
        .all()
    )
    # A search reads events and is not the event-type endpoint. Prefer an
    # explicit /search, then any non-type read.
    for row in rows:
        if "event_type" in row.path:
            continue
        if row.path.rstrip("/").endswith("/search"):
            return row.method.upper(), row.path, "catalog"
    for row in rows:
        if "event_type" in row.path:
            continue
        if row.method.upper() in ("GET", "POST") and row.path.endswith("/event"):
            return row.method.upper(), row.path, "catalog"

    method, path = FALLBACK_CANDIDATES[0]
    return method, path, "fallback"


@router.get("", response_model=PublishedResponse)
async def list_published(
    connection_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> PublishedResponse:
    conn = (
        await session.execute(select(Connection).where(Connection.id == connection_id))
    ).scalar_one_or_none()
    if conn is None or conn.type != "verkada":
        raise HTTPException(status_code=404, detail="Verkada connection not found")
    secret = decrypt_secret(conn.encrypted_secret)
    api_key = secret.get("api_key")
    org_id = secret.get("org_id") or conn.external_id
    if not api_key or not org_id:
        raise HTTPException(
            status_code=400, detail="That connection is missing an API key or org id."
        )

    method, path, source = await _resolve_search_op(session)
    client = VerkadaClient(api_key=api_key, base_url=secret.get("region") or None)

    attempts: list[tuple[str, str]] = [(method, path)]
    # If the catalog gave us nothing, try both shapes before giving up
    # rather than reporting one 403 as though it were the answer.
    if source == "fallback":
        attempts = FALLBACK_CANDIDATES

    last_status = 0
    last_body: Any = None
    for m, p in attempts:
        try:
            result = await client.request(
                method=m,
                path=p,
                query={"org_id": org_id},
                json_body={} if m == "POST" else None,
            )
        except VerkadaApiError as e:
            last_status, last_body = 502, str(e)
            continue
        status = int(result.get("status_code") or 0)
        if status >= 400:
            last_status, last_body = status, result.get("body")
            continue

        body = result.get("body")
        raw = body.get("events") if isinstance(body, dict) else None
        if not isinstance(raw, list):
            raw = []
        events = [
            PublishedEvent(
                camera_id=e.get("camera_id"),
                event_type_uid=e.get("event_type_uid"),
                time_ms=e.get("time_ms"),
                flagged=bool(e.get("flagged")),
                attributes=e.get("attributes") or {},
            )
            for e in raw
            if isinstance(e, dict)
        ][:limit]
        return PublishedResponse(
            events=events,
            next_token=body.get("next_token") if isinstance(body, dict) else None,
            path_used=p,
            method_used=m,
            source=source,
        )

    raise HTTPException(
        status_code=502,
        detail=(
            f"Verkada refused the Helix search ({last_status}). Note that 403 "
            "means either a missing scope on this key or a path this org does "
            f"not serve — they are indistinguishable. Tried: "
            f"{', '.join(f'{m} {p}' for m, p in attempts)}. Body: {last_body!r}"[:400]
        ),
    )
