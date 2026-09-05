"""Chat endpoint for in-product help."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto import decrypt_secret
from app.db import get_session
from app.help import chat as help_chat
from app.help import corpus as help_corpus
from app.models import Connection
from app.pricing import ledger


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/help", tags=["help"])


class Turn(BaseModel):
    role: str
    content: str


class HelpRequest(BaseModel):
    messages: list[Turn]


@router.post("/chat")
async def chat(
    body: HelpRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    if not body.messages:
        raise HTTPException(status_code=400, detail="ask something first")

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
                "Help needs a Gemini connection — the same key the rest of "
                "vFusion uses. Add one on the Connections page."
            ),
        )
    try:
        api_key = (decrypt_secret(conn.encrypted_secret) or {}).get("api_key")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decrypt secret: {e}") from e
    if not api_key:
        raise HTTPException(status_code=400, detail="That Gemini connection has no API key.")

    corpus = help_corpus.current()
    prompt = help_chat.build_prompt([m.model_dump() for m in body.messages], corpus)
    try:
        data, model, t_in, t_out = await asyncio.to_thread(
            help_chat.ask, api_key, prompt
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(e)) from e

    await ledger.record(model, t_in, t_out, source="Help")

    return {**data, "model": model, "corpus_chars": len(corpus)}
