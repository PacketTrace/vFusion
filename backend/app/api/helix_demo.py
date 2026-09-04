"""Fill a Helix timeline with plausible events for something not built yet.

The customer problem: Helix is much easier to want once you have seen it
working on your own cameras, and seeing it working requires an
integration nobody has built at the point of asking. This closes that
gap -- describe the system, get the event type it would write, and get a
timeline that looks like it has been running for a week.

Two endpoints. ``/compose`` asks a model for the type and a generator
specification and returns them for review; ``/seed`` expands the
specification and posts the events. Split deliberately: composing is
cheap and reversible, posting writes to a live Verkada org, and running
them together would mean discovering a wrong schema only after several
hundred rows had landed on it.

Nothing is recorded about what was posted. This is aimed at trial orgs,
where a demo is meant to be re-run with fresh data rather than tidied
away, which is what ``seed`` called twice with different seeds gives.
"""

from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.client import VerkadaClient
from app.crypto import decrypt_secret
from app.db import get_session
from app.helixdemo import compose as composer
from app.helixdemo import generate
from app.models import Connection
from app.models.verkada_api import VerkadaApiEndpoint


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/helix-demo", tags=["helix-demo"])


class ComposeRequest(BaseModel):
    gemini_connection_id: UUID
    intent: str
    # A second pass. The first answer is rarely wrong so much as not
    # yours -- groceries when the customer sells timber -- and starting
    # over loses the parts that were right.
    previous: dict[str, Any] | None = None
    refinement: str = ""


class SeedRequest(BaseModel):
    connection_id: UUID
    camera_id: str
    event_type_uid: str
    # The generator specification, as returned by /compose and possibly
    # edited on the way through.
    spec: dict[str, Any]
    count: int = 60
    window_days: int = 7
    # "business", "random", or "detections" — align to moments the camera
    # actually saw something.
    timing: str = "business"
    # Given back with the result so a replay can be an intentional
    # repeat rather than a coincidence.
    seed: int | None = None


async def _secret(session: AsyncSession, conn_id: UUID, kind: str) -> dict[str, Any]:
    conn = await session.get(Connection, conn_id)
    if conn is None or conn.type != kind:
        raise HTTPException(status_code=404, detail=f"no {kind} connection with that id")
    return decrypt_secret(conn.encrypted_secret) or {}


@router.post("/compose")
async def compose_demo(
    body: ComposeRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    secret = await _secret(session, body.gemini_connection_id, "gemini")
    api_key = secret.get("api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="that Gemini connection has no API key")
    if not body.intent.strip():
        raise HTTPException(status_code=400, detail="describe the integration first")

    try:
        raw, model = composer.compose(
            api_key, body.intent, body.previous, body.refinement
        )
        data = composer.validate(raw)
    except ValueError as e:
        # A model that returned a mismatched type and spec. Worth saying
        # plainly rather than as a 500 — asking again usually fixes it.
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(e)) from e

    # A preview built from the real generator, not a description of it.
    # Five rows are enough to see whether the totals track the counts and
    # whether the product names sound like a real shop.
    sample = generate.build_events(
        data["spec"], count=5, window_days=1, seed=0
    )
    return {
        **data,
        "model": model,
        # What the model actually said, before validation tidied it.
        # Worth being able to look at when the result is surprising:
        # the difference between "the model chose that" and "we did
        # something to it" is otherwise unknowable from the outside.
        "raw": raw,
        "sample": [
            {"attributes": e["attributes"], "at": e["at"].isoformat()}
            for e in sample
        ],
    }


async def _resolve_path(session: AsyncSession, *words: str) -> str | None:
    """Find an endpoint in vFusion's synced copy of Verkada's OpenAPI.

    Rather than hard-coding a path from memory. Verkada answers an
    unknown path with 403 "Insufficient permissions" rather than 404, so
    a wrong guess is indistinguishable from a missing scope — which has
    already cost this project two rounds of debugging the wrong thing.
    The catalog crawler exists precisely so the answer can be looked up,
    and this is the first thing to actually look it up.

    Returns None when the catalog has not been crawled yet, which the
    caller treats the same as no detections found.
    """
    rows = (
        await session.execute(
            select(VerkadaApiEndpoint).where(
                VerkadaApiEndpoint.method == "GET",
                VerkadaApiEndpoint.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    best: tuple[int, str] | None = None
    for row in rows:
        haystack = " ".join(
            filter(None, [row.path, row.operation_id, row.summary])
        ).lower()
        score = sum(1 for w in words if w in haystack)
        if score < len(words):
            continue
        # Shortest match wins: /cameras/v1/.../search beats the same
        # thing with a trailing sub-resource.
        if best is None or len(row.path) < best[0]:
            best = (len(row.path), row.path)
    return best[1] if best else None


async def _detection_times(
    session: AsyncSession,
    client: VerkadaClient,
    camera_id: str,
    start: datetime,
    end: datetime,
) -> list[datetime]:
    """Moments this camera actually saw a person or a vehicle.

    The most convincing timing there is: an event stamped at a second
    when somebody really walked through the door means clicking it in
    Command shows a person rather than an empty room.

    Object *counts* are the wrong source — they are totals per bucket,
    not moments. What is wanted is the object search, which returns one
    row per detection with the exact best frame.

    Best effort throughout. A camera with detection history switched off
    returns nothing, which is indistinguishable from a quiet week, so
    every failure here falls back to a shaped-random timeline rather than
    failing the seed.
    """
    path = await _resolve_path(session, "object", "search")
    if not path:
        logger.info("no object-search endpoint in the catalog; skipping anchors")
        return []

    out: list[datetime] = []
    for label in ("person", "vehicle"):
        try:
            result = await client.request(
                method="GET",
                path=path.replace("{camera_id}", camera_id),
                query={
                    "camera_id": camera_id,
                    "label": label,
                    "start_time": int(start.timestamp()),
                    "end_time": int(end.timestamp()),
                },
            )
        except Exception as e:  # noqa: BLE001
            logger.info("detection lookup failed (%s): %s", label, e)
            continue
        body = result.get("body") if isinstance(result, dict) else None
        if not isinstance(body, dict):
            continue
        rows = body.get("detections") or body.get("object_detections") or []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            ms = row.get("best_frame_ms") or row.get("first_seen_ms")
            if not ms:
                continue
            try:
                out.append(datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc))
            except (TypeError, ValueError, OSError):
                continue
    return out


@router.post("/seed")
async def seed(
    body: SeedRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    secret = await _secret(session, body.connection_id, "verkada")
    api_key = secret.get("api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="that Verkada connection has no API key")
    org_id = secret.get("org_id")
    if not body.camera_id.strip():
        raise HTTPException(status_code=400, detail="pick a camera")
    if not body.event_type_uid.strip():
        raise HTTPException(status_code=400, detail="pick or create the event type first")

    seed_value = body.seed if body.seed is not None else random.randrange(1, 2**31)
    client = VerkadaClient(api_key=api_key, base_url=secret.get("region") or None)

    anchors: list[datetime] = []
    used_timing = body.timing
    if body.timing == "detections":
        now = datetime.now(timezone.utc)
        anchors = await _detection_times(
            session,
            client,
            body.camera_id,
            now - timedelta(days=body.window_days),
            now,
        )
        if not anchors:
            # Say so rather than silently producing a uniform scatter the
            # operator did not ask for and would not be able to tell from
            # the real thing.
            used_timing = "business"

    events = generate.build_events(
        body.spec,
        count=body.count,
        window_days=body.window_days,
        seed=seed_value,
        anchors=anchors or None,
        timing_shape=None if used_timing == "detections" else used_timing,
    )

    posted = 0
    failures: list[str] = []
    for event in events:
        payload = {
            "camera_id": body.camera_id,
            "event_type_uid": body.event_type_uid,
            "time_ms": int(event["at"].timestamp() * 1000),
            "attributes": event["attributes"],
        }
        try:
            result = await client.request(
                method="POST",
                path="/cameras/v1/video_tagging/event",
                query={"org_id": org_id} if org_id else None,
                json_body=payload,
            )
        except Exception as e:  # noqa: BLE001
            failures.append(str(e))
            continue
        if result.get("status_code", 500) >= 400:
            failures.append(f"{result.get('status_code')}: {result.get('body')!r}")
            continue
        posted += 1
        # Stop hammering a rejecting endpoint. Five identical failures is
        # a schema mismatch, not bad luck, and the remaining hundreds
        # will fail the same way.
        if len(failures) >= 5 and posted == 0:
            break

    return {
        "posted": posted,
        "requested": len(events),
        "seed": seed_value,
        "timing": used_timing,
        "anchored_to_detections": bool(anchors),
        "first_at": events[0]["at"].isoformat() if events else None,
        "last_at": events[-1]["at"].isoformat() if events else None,
        # First few only: a hundred identical timeouts is not more
        # informative than five.
        "errors": failures[:5],
    }
