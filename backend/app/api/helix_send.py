"""Post one Helix event by hand.

Everything that writes to Helix in vFusion goes through a flow, which
means the only way to see whether an event type actually works is to
build an automation and wait for it to fire. That is a long way round
for "does this type accept what I think it accepts", and it is the
question people have right after creating one.

The auth is handled here rather than by the caller: Verkada wants a
POST /token with the org API key and then an ``x-verkada-auth`` header
on the real call, and the key must never reach the browser. The UI
sends a connection id; ``VerkadaClient`` does the rest.

Type errors are reported per field. Helix answers a bad payload with one
message about the whole request, so a five-attribute event with one
mistyped value tells you only that something was wrong -- this returns
which attribute, what it wanted, and what it got.
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

from app.connectors.verkada.client import VerkadaApiError, VerkadaClient
from app.crypto import decrypt_secret
from app.db import get_session
from app.engine.actions.verkada_helix_event import _coerce_attr_value
from app.models import Connection, VerkadaHelixEventType


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/helix-send", tags=["helix-send"])


class SendRequest(BaseModel):
    connection_id: UUID
    event_type_uid: str
    camera_id: str
    # Unix milliseconds. Omitted means now, which is what somebody
    # testing a type almost always wants.
    time_ms: int | None = None
    attributes: dict[str, Any] = {}


class FieldProblem(BaseModel):
    attribute: str
    expected: str
    got: str
    message: str


class SendResponse(BaseModel):
    ok: bool
    status_code: int
    body: Any = None
    # What was actually sent, after coercion. A float field that arrived
    # as the string "12" goes over as the number 12, and seeing that is
    # most of the value of a manual send.
    sent: dict[str, Any] = {}
    time_ms: int


def _describe(value: Any) -> str:
    if value is None or value == "":
        return "empty"
    return f'"{value}"' if isinstance(value, str) else str(value)


@router.post("", response_model=SendResponse)
async def send_event(
    body: SendRequest,
    session: AsyncSession = Depends(get_session),
) -> SendResponse:
    conn = (
        await session.execute(
            select(Connection).where(Connection.id == body.connection_id)
        )
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
    if not body.camera_id.strip():
        raise HTTPException(status_code=400, detail="Pick a camera.")

    # The locally synced schema, so a wrong type is caught here with the
    # attribute's name attached rather than by Helix as one opaque
    # rejection of the whole payload.
    row = (
        await session.execute(
            select(VerkadaHelixEventType).where(
                VerkadaHelixEventType.connection_id == conn.id,
                VerkadaHelixEventType.event_type_uid == body.event_type_uid,
            )
        )
    ).scalar_one_or_none()
    schema: dict[str, str] = {}
    if row and isinstance(row.event_schema, dict):
        schema = {str(k): str(v) for k, v in row.event_schema.items()}

    problems: list[FieldProblem] = []
    sent: dict[str, Any] = {}
    for key, raw in body.attributes.items():
        declared = schema.get(key)
        try:
            coerced = _coerce_attr_value(raw, declared)
        except ValueError:
            expected = (declared or "string").lower()
            problems.append(
                FieldProblem(
                    attribute=key,
                    expected=expected,
                    got=_describe(raw),
                    message=(
                        f"{key} is {expected} on this event type, and "
                        f"{_describe(raw)} is not a number."
                        if expected in ("integer", "float")
                        else f"{key} could not be converted to {expected}."
                    ),
                )
            )
            continue
        # None means "unfilled" — dropped rather than sent, so an empty
        # optional field does not fail schema validation.
        if coerced is not None:
            sent[key] = coerced

    if problems:
        raise HTTPException(
            status_code=422,
            detail={"message": "Some attributes do not match the type.", "fields": [p.model_dump() for p in problems]},
        )

    time_ms = body.time_ms if body.time_ms else int(time.time() * 1000)
    payload = {
        "camera_id": body.camera_id.strip(),
        "event_type_uid": body.event_type_uid,
        "time_ms": time_ms,
        "attributes": sent,
    }

    client = VerkadaClient(api_key=api_key, base_url=secret.get("region") or None)
    try:
        result = await client.request(
            method="POST",
            path="/cameras/v1/video_tagging/event",
            query={"org_id": org_id},
            json_body=payload,
        )
    except VerkadaApiError as e:
        raise HTTPException(status_code=502, detail=str(e))

    status = int(result.get("status_code") or 0)
    return SendResponse(
        ok=status < 400,
        status_code=status,
        body=result.get("body"),
        sent=sent,
        time_ms=time_ms,
    )
