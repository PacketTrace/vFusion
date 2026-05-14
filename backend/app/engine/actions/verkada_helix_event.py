"""Action: post a Verkada Helix video-tagging event.

Helix attribute values are capped at 200 characters each. A typical
"Summary" attribute carries a one-line AI description. Use a JSON
field for attributes so the user can construct arbitrary key/value
pairs with template refs:

    {
        "Summary": "{{ steps.analyze.output.text }}",
        "Confidence": "{{ steps.analyze.output.model_used }}"
    }

Internally this just POSTs to /cameras/v1/video_tagging/event via
VerkadaClient.request — identical to what a generic verkada_api_call
would do, but with friendlier fields the user doesn't have to
construct from scratch.
"""

import json
from typing import Any

from sqlalchemy import select

from app.connectors.verkada.client import VerkadaApiError, VerkadaClient
from app.crypto import decrypt_secret
from app.db import SessionLocal
from app.engine.templates import resolve_deep
from app.models import Connection, VerkadaHelixEventType


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "connection_id",
            "label": "Verkada connection",
            "type": "connection_ref",
            "connection_type": "verkada",
            "required": True,
        },
        {
            "name": "camera_id",
            "label": "Camera ID",
            "type": "text",
            "required": True,
            "help": "Auto-fills from {{ trigger.data.camera_id }} when present.",
        },
        {
            "name": "event_type_uid",
            "label": "Helix event type",
            "type": "helix_event_ref",
            "connection_field": "connection_id",
            "attributes_field": "attributes",
            "required": True,
            "help": "Pick an event type to auto-populate the attribute fields below. Click 'Sync helix' on the connection if your event type isn't listed.",
        },
        {
            "name": "attributes",
            "label": "Attributes",
            "type": "helix_attributes",
            "event_type_field": "event_type_uid",
            "connection_field": "connection_id",
            "required": True,
            "help": 'Each value is templated — paste {{ steps.analyze.output.text }} to use prior step output. Values are stringified and truncated to 200 chars by Helix.',
        },
        {
            "name": "time_ms",
            "label": "Event time (unix milliseconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "default_template": "{{ trigger.data.created }}000",
            "help": 'Auto-fills from {{ trigger.data.created }}000 so the Helix event lands at motion time, not when this step ran. Blank it out to use "now" instead.',
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "verkada_helix_event",
    "camera_id": "...",
    "event_type_uid": "...",
    "time_ms": 1700000000000,
    "verkada_response": {"status_code": 200, "body": {}},
}


def _coerce_int(v: Any, default: int) -> int:
    try:
        return int(float(str(v).strip()))
    except (ValueError, TypeError):
        return default


def _coerce_attr_value(value: Any, declared_type: str | None) -> Any:
    """Convert one attribute value into the JSON shape Helix expects given
    the event_schema's declared type. Helix rejects type mismatches at the
    schema-validation step, so a float field must be a JSON number, not a
    quoted string.

    Returns None to signal "drop this key" (e.g. empty string for a numeric
    field) — those get filtered out before POST so we don't fail validation
    on an unfilled optional field."""
    t = (declared_type or "string").lower()
    if t == "float":
        if value in (None, ""):
            return None
        try:
            return float(value)
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"value {value!r} can't be coerced to float for this attribute"
            ) from e
    if t == "integer":
        if value in (None, ""):
            return None
        try:
            return int(float(value))
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"value {value!r} can't be coerced to integer for this attribute"
            ) from e
    # Default: string. Helix caps values at 200 chars.
    if value is None:
        return ""
    s = value if isinstance(value, str) else str(value)
    return s[:200]


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    secret = decrypt_secret(connection.encrypted_secret)
    api_key = secret.get("api_key")
    org_id = secret.get("org_id") or connection.external_id
    if not api_key:
        raise ValueError("Verkada connection has no api_key set")
    if not org_id:
        raise ValueError("Verkada connection has no org_id")
    region = secret.get("region") or None

    camera_id = resolve_deep(config.get("camera_id"), ctx)
    event_type_uid = resolve_deep(config.get("event_type_uid"), ctx)
    attributes = resolve_deep(config.get("attributes"), ctx)
    time_ms_raw = resolve_deep(config.get("time_ms"), ctx)

    if not isinstance(camera_id, str) or not camera_id:
        raise ValueError("camera_id is required")
    if not isinstance(event_type_uid, str) or not event_type_uid:
        raise ValueError("event_type_uid is required")
    if not isinstance(attributes, dict) or not attributes:
        raise ValueError("attributes must be a non-empty JSON object")

    if time_ms_raw is None or time_ms_raw == "":
        import time as _time

        time_ms = int(_time.time() * 1000)
    else:
        time_ms = _coerce_int(time_ms_raw, 0)
        if time_ms <= 0:
            raise ValueError(f"time_ms must be a positive integer, got {time_ms_raw!r}")

    # Pull the event_schema for this event_type_uid from our local cache
    # (populated by the "Sync helix" button on Connections). The schema
    # tells us which fields are float/integer vs string so we can coerce
    # each value to the JSON shape Helix actually expects. Without this,
    # 1.0 in a "float" field gets posted as "1.0" (string) and Helix
    # rejects with "Wrong type for field …".
    schema: dict[str, str] = {}
    async with SessionLocal() as session:
        row = (
            await session.execute(
                select(VerkadaHelixEventType).where(
                    VerkadaHelixEventType.connection_id == connection.id,
                    VerkadaHelixEventType.event_type_uid == event_type_uid,
                )
            )
        ).scalar_one_or_none()
        if row and isinstance(row.event_schema, dict):
            schema = {str(k): str(v) for k, v in row.event_schema.items()}

    safe_attrs: dict[str, Any] = {}
    for k, v in attributes.items():
        coerced = _coerce_attr_value(v, schema.get(str(k)))
        if coerced is None:
            # Empty number field — drop it. Helix will treat it as absent.
            continue
        safe_attrs[str(k)] = coerced

    body = {
        "camera_id": camera_id,
        "event_type_uid": event_type_uid,
        "time_ms": time_ms,
        "attributes": safe_attrs,
    }

    # Surface the exact POST body in the run's log panel BEFORE we send
    # it. Critical for debugging "Wrong type for field …" errors — you
    # can see at a glance whether the value went over as a string vs
    # number vs whatever.
    progress = ctx.get("_progress")
    if progress:
        await progress.log(
            "POST /cameras/v1/video_tagging/event → "
            + json.dumps(body, default=str)
        )

    client = VerkadaClient(api_key=api_key, base_url=region)
    try:
        result = await client.request(
            method="POST",
            path="/cameras/v1/video_tagging/event",
            query={"org_id": org_id},
            json_body=body,
        )
    except VerkadaApiError as e:
        raise ValueError(str(e)) from e
    if result["status_code"] >= 400:
        if progress:
            await progress.log(
                f"Helix responded {result['status_code']}: "
                + json.dumps(result.get("body"), default=str)
            )
        raise ValueError(
            f"Helix post → {result['status_code']}: {result['body']!r}"
        )

    return {
        "action": "verkada_helix_event",
        "camera_id": camera_id,
        "event_type_uid": event_type_uid,
        "time_ms": time_ms,
        # Echo back the exact attributes payload we sent so the Runs page
        # has it under the step's Output → Details disclosure, not just
        # transiently in the Log panel.
        "request_body": body,
        "verkada_response": result,
    }
