"""Gemini cost estimation.

We store per-model token rates in the ``gemini_pricing`` table and
recompute per-run cost from the token counts each generate call reports.
The numbers are *estimates* — Google's published rates, not invoice
reconciliation — so the UI labels them as such.

The daily ``refresh_gemini_pricing_cron`` upserts the hardcoded rates
below into the table and stamps ``fetched_at``. The hardcoded table is
the source of truth; the cron exists so the read path is always a
single SQL query (and so a future "scrape Google's pricing page" task
can swap in without breaking anything else). When prices move in real
life, update FALLBACK_PRICES + the date in CURRENT_AS_OF.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db import SessionLocal
from app.models import GeminiPricing


# Source: https://ai.google.dev/gemini-api/docs/pricing — paid-tier
# standard pricing (we don't currently use batch). Last verified on
# CURRENT_AS_OF; bump that date + edit the numbers when Google moves
# prices, then run the cron (or restart the backend) to push the new
# table into the DB.
CURRENT_AS_OF = "2026-05-12"

FALLBACK_PRICES: list[dict[str, Any]] = [
    {
        "model": "gemini-2.5-flash",
        "input_per_1m_usd": Decimal("0.30"),
        "output_per_1m_usd": Decimal("2.50"),
    },
    {
        "model": "gemini-2.5-pro",
        "input_per_1m_usd": Decimal("1.25"),
        "output_per_1m_usd": Decimal("10.00"),
        "input_per_1m_long_usd": Decimal("2.50"),
        "output_per_1m_long_usd": Decimal("15.00"),
        "long_threshold_tokens": 200_000,
    },
    {
        "model": "gemini-3.1-flash-lite",
        "input_per_1m_usd": Decimal("0.25"),
        "output_per_1m_usd": Decimal("1.50"),
    },
    {
        "model": "gemini-3.1-pro-preview",
        "input_per_1m_usd": Decimal("2.00"),
        "output_per_1m_usd": Decimal("12.00"),
        "input_per_1m_long_usd": Decimal("4.00"),
        "output_per_1m_long_usd": Decimal("18.00"),
        "long_threshold_tokens": 200_000,
    },
    {
        "model": "gemini-3-flash-preview",
        "input_per_1m_usd": Decimal("0.50"),
        "output_per_1m_usd": Decimal("3.00"),
    },
]


def _rate_for(row: GeminiPricing, in_tokens: int) -> tuple[Decimal, Decimal]:
    """Pick the right per-1M rate pair given the prompt length. Long-context
    tier kicks in only for models that declare it."""
    long_threshold = row.long_threshold_tokens
    if (
        long_threshold is not None
        and in_tokens > long_threshold
        and row.input_per_1m_long_usd is not None
        and row.output_per_1m_long_usd is not None
    ):
        return row.input_per_1m_long_usd, row.output_per_1m_long_usd
    return row.input_per_1m_usd, row.output_per_1m_usd


async def cost_for(
    model: str, in_tokens: int, out_tokens: int
) -> dict[str, Any] | None:
    """Look up published rates and return an estimated cost dict for the
    given token counts. Returns None if the model is unknown to us — the
    caller can decide to display "—" or skip the cost field. Numbers are
    rounded to 6 decimal places (sub-cent precision)."""
    async with SessionLocal() as session:
        row = (
            await session.execute(
                select(GeminiPricing).where(GeminiPricing.model == model)
            )
        ).scalar_one_or_none()
    if row is None:
        return None
    in_rate, out_rate = _rate_for(row, in_tokens)
    cost_in = (Decimal(in_tokens) / Decimal(1_000_000)) * in_rate
    cost_out = (Decimal(out_tokens) / Decimal(1_000_000)) * out_rate
    total = (cost_in + cost_out).quantize(Decimal("0.000001"))
    return {
        "model": model,
        "tokens_in": in_tokens,
        "tokens_out": out_tokens,
        "input_rate_per_1m_usd": float(in_rate),
        "output_rate_per_1m_usd": float(out_rate),
        "cost_usd": float(total),
        "rates_fetched_at": row.fetched_at.isoformat(),
    }


async def refresh_gemini_pricing() -> dict[str, Any]:
    """Upsert FALLBACK_PRICES into the gemini_pricing table. Designed to
    be called by a daily cron — when we later add a live scrape of
    Google's pricing page, this is the function to extend."""
    now = datetime.now(timezone.utc)
    updated = 0
    async with SessionLocal() as session:
        for entry in FALLBACK_PRICES:
            stmt = (
                pg_insert(GeminiPricing)
                .values(
                    model=entry["model"],
                    input_per_1m_usd=entry["input_per_1m_usd"],
                    output_per_1m_usd=entry["output_per_1m_usd"],
                    input_per_1m_long_usd=entry.get("input_per_1m_long_usd"),
                    output_per_1m_long_usd=entry.get("output_per_1m_long_usd"),
                    long_threshold_tokens=entry.get("long_threshold_tokens"),
                    source=f"hardcoded@{CURRENT_AS_OF}",
                    fetched_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["model"],
                    set_={
                        "input_per_1m_usd": entry["input_per_1m_usd"],
                        "output_per_1m_usd": entry["output_per_1m_usd"],
                        "input_per_1m_long_usd": entry.get("input_per_1m_long_usd"),
                        "output_per_1m_long_usd": entry.get("output_per_1m_long_usd"),
                        "long_threshold_tokens": entry.get("long_threshold_tokens"),
                        "source": f"hardcoded@{CURRENT_AS_OF}",
                        "fetched_at": now,
                    },
                )
            )
            await session.execute(stmt)
            updated += 1
        await session.commit()
    return {"updated": updated, "as_of": CURRENT_AS_OF}
