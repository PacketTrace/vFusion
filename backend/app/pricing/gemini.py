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

import logging
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db import SessionLocal
from app.models import GeminiPricing


logger = logging.getLogger(__name__)


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


# Google's public pricing page. The HTML structure isn't stable —
# this scrape is best-effort and falls back to FALLBACK_PRICES whenever
# anything goes sideways.
_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing"


async def _scrape_pricing() -> list[dict[str, Any]] | None:
    """Try to extract input/output rates for the models in
    ``FALLBACK_PRICES`` from Google's docs page. Returns merged
    entries (scrape's short-context prices + FALLBACK_PRICES'
    long-context tiers where present) or None on any failure."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.get(
                _PRICING_URL,
                follow_redirects=True,
                headers={"accept-language": "en-US,en;q=0.9"},
            )
    except Exception as e:  # noqa: BLE001 — broad on purpose; ALL failures fall back
        logger.info("Gemini pricing scrape: fetch failed (%s)", e)
        return None
    if res.status_code >= 400:
        logger.info("Gemini pricing scrape: HTTP %d", res.status_code)
        return None
    html_text = res.text or ""
    # Sanity check before regex-matching: if the page is suspiciously
    # small or doesn't mention any model name we know about, bail.
    known_models = {p["model"] for p in FALLBACK_PRICES}
    if len(html_text) < 5000 or not any(m in html_text for m in known_models):
        logger.info("Gemini pricing scrape: page didn't look like pricing")
        return None

    # Heuristic: for each known model, find the first occurrence of its
    # name in the page, then look ahead a bounded window for two dollar
    # amounts. Captures input + output rates per million tokens for the
    # standard tier. Long-context tier is left to FALLBACK_PRICES.
    rates: dict[str, tuple[Decimal, Decimal]] = {}
    for model in known_models:
        # Use the literal model id as the anchor — distinctive enough
        # to find the right section. ``re.IGNORECASE`` because docs
        # sometimes title-case in headings.
        idx = html_text.lower().find(model.lower())
        if idx < 0:
            continue
        window = html_text[idx : idx + 3000]
        money = re.findall(r"\$\s*(\d+(?:\.\d+)?)", window)
        if len(money) < 2:
            continue
        try:
            in_price = Decimal(money[0])
            out_price = Decimal(money[1])
        except ArithmeticError:
            continue
        # Sanity bounds — anything outside this range is almost certainly
        # a stray number rather than a real per-million-token rate.
        if in_price <= 0 or in_price > 100 or out_price <= 0 or out_price > 100:
            continue
        rates[model] = (in_price, out_price)

    # Need at least half the known models to consider the scrape a
    # success — otherwise we're probably misparsing.
    if len(rates) < max(2, len(known_models) // 2):
        logger.info(
            "Gemini pricing scrape: only matched %d of %d models, falling back",
            len(rates),
            len(known_models),
        )
        return None

    logger.info(
        "Gemini pricing scrape: matched %d of %d models",
        len(rates),
        len(known_models),
    )
    # Merge with FALLBACK_PRICES so we keep long-context tiers + any
    # models the scrape missed.
    fb_by_model = {p["model"]: p for p in FALLBACK_PRICES}
    merged: list[dict[str, Any]] = []
    for model, fb in fb_by_model.items():
        scraped = rates.get(model)
        entry: dict[str, Any] = dict(fb)
        if scraped is not None:
            entry["input_per_1m_usd"] = scraped[0]
            entry["output_per_1m_usd"] = scraped[1]
        merged.append(entry)
    return merged


async def refresh_gemini_pricing() -> dict[str, Any]:
    """Upsert published Gemini pricing into the gemini_pricing table.

    Tries a live scrape of Google's pricing page first; on any failure
    (fetch error, structure change, sanity-check rejection) silently
    falls back to ``FALLBACK_PRICES``. The ``source`` column on each
    row records which path won so the Stats page (and operator) can
    see whether prices are fresh from the docs or from the hardcoded
    snapshot.
    """
    now = datetime.now(timezone.utc)
    scraped = await _scrape_pricing()
    if scraped is not None:
        entries = scraped
        source_tag = f"scraped@{now.date().isoformat()}"
    else:
        entries = FALLBACK_PRICES
        source_tag = f"hardcoded@{CURRENT_AS_OF}"
    updated = 0
    async with SessionLocal() as session:
        for entry in entries:
            stmt = (
                pg_insert(GeminiPricing)
                .values(
                    model=entry["model"],
                    input_per_1m_usd=entry["input_per_1m_usd"],
                    output_per_1m_usd=entry["output_per_1m_usd"],
                    input_per_1m_long_usd=entry.get("input_per_1m_long_usd"),
                    output_per_1m_long_usd=entry.get("output_per_1m_long_usd"),
                    long_threshold_tokens=entry.get("long_threshold_tokens"),
                    source=source_tag,
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
                        "source": source_tag,
                        "fetched_at": now,
                    },
                )
            )
            await session.execute(stmt)
            updated += 1
        await session.commit()
    return {"updated": updated, "source": source_tag}
