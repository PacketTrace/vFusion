"""Draft a Helix event type from a sentence.

The manual path asks for a name and then an unbounded list of
attribute-name/type pairs against an empty box. That is the hardest
moment in building a flow by hand: nothing on screen says what a good
attribute is, how many to have, or that Helix will truncate a long value
-- and the cost of guessing wrong is a type that already has events
posted against it.

Deliberately smaller than the analytic composer in ``byoa.py`` and the
demo composer in ``helixdemo/compose.py``. Those two design a prompt and
a data generator alongside the type; this one is asked at the moment
somebody is staring at an empty attribute row, and it answers only that
question.
"""

from __future__ import annotations

import json as _json
import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto import decrypt_secret
from app.db import get_session
from app.models import Connection
from app.pricing.gemini import cost_for
from app.pricing.ledger import record as record_spend


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/helix-assist", tags=["helix-assist"])

MODELS = ("gemini-2.5-flash", "gemini-3.1-flash-lite")

PROMPT = """You design Verkada Helix event types.

Helix attaches structured events to a camera's timeline. Someone is
building an automation and needs the event type it will write into.

They described what they want to log:

__INTENT__

__CONTEXT__

Return ONLY this JSON object:

{
  "name": "event type name, Title Case, may start with one emoji",
  "attributes": [
    {"key": "Attribute Name", "type": "string", "why": "one short phrase"}
  ]
}

Rules that matter:

- Between 2 and 6 attributes. This is a timeline row somebody reads at a
  glance, not a database table. More than six and the useful ones are
  buried.
- Attribute names are Title Case and human readable -- they are column
  headings in Command, not code identifiers.
- Type is "string", "integer" or "float". Prefer "string": Helix stores
  everything as text anyway, and a number that might arrive as "12 lb"
  or "unknown" breaks a numeric field. Use integer or float only for a
  value that is always a bare number.
- Every value is truncated past 200 characters, so never design an
  attribute whose typical value is a paragraph or a long list. One
  summary sentence is fine; a transcript is not.
- Describe what happened, not what triggered it. The timeline already
  knows the camera and the time, so a "Camera" or "Timestamp" attribute
  is wasted width.
- "why" is one short phrase saying what goes in the field. It is shown
  to the operator as help text and is not sent to Verkada.
"""

CONTEXT_BLOCK = """They are building this inside a flow that starts on:

__TRIGGER__

Attributes that can be filled from that trigger are more useful than
ones nobody has a source for."""


class AssistRequest(BaseModel):
    intent: str
    gemini_connection_id: UUID
    # What the flow's trigger is, when the caller knows. Free text —
    # "Access / Door Event · door_opened" is enough for the model to
    # prefer attributes the trigger can actually populate.
    trigger_summary: str | None = None


class AssistAttribute(BaseModel):
    key: str
    type: str
    why: str | None = None


class AssistResponse(BaseModel):
    name: str
    attributes: list[AssistAttribute]
    model_used: str
    cost_usd: float | None = None


def _compose(api_key: str, intent: str, trigger: str | None) -> tuple[dict[str, Any], str, int, int]:
    from google import genai

    context = (
        CONTEXT_BLOCK.replace("__TRIGGER__", trigger.strip())
        if trigger and trigger.strip()
        else ""
    )
    prompt = PROMPT.replace("__INTENT__", intent.strip()).replace(
        "__CONTEXT__", context
    )
    client = genai.Client(api_key=api_key)
    last: Exception | None = None
    for model in MODELS:
        try:
            res = client.models.generate_content(
                model=model,
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "max_output_tokens": 1024,
                },
            )
            text = (res.text or "").strip()
            if not text:
                raise RuntimeError("model returned an empty response")
            usage = getattr(res, "usage_metadata", None)
            return (
                _json.loads(text),
                model,
                int(getattr(usage, "prompt_token_count", 0) or 0),
                int(getattr(usage, "candidates_token_count", 0) or 0),
            )
        except Exception as e:  # noqa: BLE001 — try the next model
            last = e
            continue
    raise RuntimeError(f"could not draft an event type: {last}")


def _validate(data: Any) -> tuple[str, list[AssistAttribute]]:
    """Reject a draft the form could not render.

    A missing type or a duplicated key would reach the editor as a blank
    row or a silently dropped attribute -- the operator would fix it
    without ever knowing something had been lost.
    """
    if not isinstance(data, dict):
        raise ValueError("model did not return an object")
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError("draft has no name")

    raw = data.get("attributes")
    if not isinstance(raw, list) or not raw:
        raise ValueError("draft has no attributes")

    out: list[AssistAttribute] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if not key or key.lower() in seen:
            continue
        seen.add(key.lower())
        kind = str(item.get("type") or "string").strip().lower()
        if kind not in ("string", "integer", "float"):
            kind = "string"
        why = str(item.get("why") or "").strip() or None
        out.append(AssistAttribute(key=key, type=kind, why=why))
    if not out:
        raise ValueError("draft had no usable attributes")
    return name, out[:6]


@router.post("", response_model=AssistResponse)
async def draft_event_type(
    body: AssistRequest,
    session: AsyncSession = Depends(get_session),
) -> AssistResponse:
    if not body.intent.strip():
        raise HTTPException(status_code=400, detail="Describe what you want to log.")

    conn = (
        await session.execute(
            select(Connection).where(Connection.id == body.gemini_connection_id)
        )
    ).scalar_one_or_none()
    if conn is None or conn.type != "gemini":
        raise HTTPException(status_code=404, detail="Gemini connection not found")
    api_key = decrypt_secret(conn.encrypted_secret).get("api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="That Gemini connection has no API key.")

    import asyncio

    try:
        data, model, tok_in, tok_out = await asyncio.to_thread(
            _compose, api_key, body.intent, body.trigger_summary
        )
        name, attrs = _validate(data)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=f"model returned an unusable draft: {e}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(e))

    # Spend outside a flow run, so it has to be recorded here or it never
    # reaches the Cost page at all.
    cost = await cost_for(model, tok_in, tok_out)
    await record_spend(model, tok_in, tok_out, source="Helix type assist")
    return AssistResponse(
        name=name,
        attributes=attrs,
        model_used=model,
        cost_usd=float(cost["cost_usd"]) if cost else None,
    )
