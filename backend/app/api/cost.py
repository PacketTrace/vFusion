"""The spending cap, and what it can and cannot do."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.pricing import budget
from app.settings_store import invalidate_cache, set_value


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cost", tags=["cost"])


class CapRequest(BaseModel):
    enabled: bool
    cap_usd: float


@router.get("/state")
async def state(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await budget.state(session)


@router.put("/cap")
async def set_cap(
    body: CapRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    await set_value(session, budget.ENABLED_KEY, "1" if body.enabled else "0")
    await set_value(session, budget.CAP_KEY, f"{max(0.0, body.cap_usd):.2f}")
    await session.commit()
    invalidate_cache()
    return await budget.state(session)
