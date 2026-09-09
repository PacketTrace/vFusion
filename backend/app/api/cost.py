"""The spending cap, and what it can and cannot do."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.pricing import budget
from app.settings_store import invalidate_cache, set_value


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cost", tags=["cost"])


class ModelSpend(BaseModel):
    model: str
    # Billed calls. Named "runs" from when a run was the only way to
    # reach Gemini; it counts ledger entries too now.
    runs: int
    tokens_in: int
    tokens_out: int
    cost_usd: float


class PricingRow(BaseModel):
    model: str
    # Declared float rather than left to a bare dict, because the column
    # is Numeric(10,4) and SQLAlchemy hands back a Decimal, which JSON
    # has no type for -- so it serialises as the *string* "0.3000" and
    # the page dies on .toFixed of a string. Naming the type here makes
    # pydantic coerce it on the way out, so the shape cannot drift back.
    input_per_1m_usd: float
    output_per_1m_usd: float
    fetched_at: datetime | None = None


class ModelsResponse(BaseModel):
    since: datetime
    by_model: list[ModelSpend]
    pricing: list[PricingRow]


class CapRequest(BaseModel):
    enabled: bool
    cap_usd: float


@router.get("/state")
async def state(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await budget.state(session)


@router.get("/breakdown")
async def breakdown(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Where this month's spend went, per source and per flow."""
    return await budget.breakdown(session, budget.month_start())


@router.get("/models", response_model=ModelsResponse)
async def models(session: AsyncSession = Depends(get_session)) -> ModelsResponse:
    """Per-model spend this month, and the rates it was priced with.

    Month to date rather than a rolling thirty days, so it agrees with
    the number at the top of this page. Those two disagreeing by a few
    days of spend, with no label saying why, is worse than not showing
    the breakdown at all.
    """
    from sqlalchemy import select

    from app.models import GeminiPricing

    since = budget.month_start()
    rows = (
        await session.execute(select(GeminiPricing).order_by(GeminiPricing.model.asc()))
    ).scalars().all()
    return ModelsResponse(
        since=since,
        by_model=[ModelSpend(**m) for m in await budget.by_model(session, since)],
        pricing=[PricingRow.model_validate(r, from_attributes=True) for r in rows],
    )


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
