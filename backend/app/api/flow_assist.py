"""Chat endpoint for the flow builder's assistant.

One call per turn. Stateless on the server: the browser holds the thread
and sends it back, which keeps this endpoint free of session storage and
means an abandoned conversation costs nothing to forget.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.schemas import TAXONOMY
from app.crypto import decrypt_secret
from app.db import get_session
from app.flows import assistant
from app.flows import context as flow_context
from app.models import Connection
from app.pricing import ledger


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/flow-assist", tags=["flow-assist"])


class Turn(BaseModel):
    role: str
    content: str


class AssistRequest(BaseModel):
    # Optional, and resolved the same way the builder resolves it: fall
    # back to the first Gemini connection. The panel sits beside the
    # builder, so asking the operator to pick a key there and not here
    # would be a question with one right answer.
    gemini_connection_id: UUID | None = None
    messages: list[Turn]
    # What is on the canvas, if anything. Sent by the browser rather than
    # looked up, because an unsaved draft only exists there.
    flow: dict[str, Any] | None = None
    verkada_connection_id: UUID | None = None


@router.post("/chat")
async def chat(
    body: AssistRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    if not body.messages:
        raise HTTPException(status_code=400, detail="ask something first")

    conn = None
    if body.gemini_connection_id:
        conn = await session.get(Connection, body.gemini_connection_id)
    if conn is None:
        conn = (
            await session.execute(
                select(Connection)
                .where(Connection.type == "gemini")
                .order_by(Connection.created_at.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if conn is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "No Gemini connection configured. The assistant uses the same "
                "key the builder does — add one on the Connections page."
            ),
        )
    try:
        api_key = (decrypt_secret(conn.encrypted_secret) or {}).get("api_key")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decrypt secret: {e}") from e
    if not api_key:
        raise HTTPException(
            status_code=400, detail="That Gemini connection has no API key yet."
        )

    org = await flow_context.org_context(session, body.verkada_connection_id)
    flows = await flow_context.existing_flows(session)
    blocks = [
        flow_context.as_prompt_block("TRIGGER TAXONOMY", TAXONOMY),
        flow_context.as_prompt_block("ACTION CATALOG", flow_context.action_catalog()),
        flow_context.as_prompt_block("THIS ORG'S DEVICES", org),
        flow_context.as_prompt_block("FLOWS THIS INSTALL ALREADY HAS", flows),
    ]
    prompt = assistant.build_prompt(
        messages=[m.model_dump() for m in body.messages],
        context_blocks=blocks,
        current_flow=body.flow,
    )

    try:
        data, model, t_in, t_out = await asyncio.to_thread(
            assistant.ask, api_key, prompt
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(e)) from e

    await ledger.record(model, t_in, t_out, source="Flow assistant")

    return {
        **data,
        "model": model,
        # Worth showing: the grounding is the whole point, and a number
        # makes it checkable rather than a claim.
        "context_chars": sum(len(b) for b in blocks),
        "known_flows": len(flows),
        "known_cameras": len(org.get("cameras") or []),
    }
