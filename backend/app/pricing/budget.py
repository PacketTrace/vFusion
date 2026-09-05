"""A spending cap that stops flows, and is honest about what it isn't.

vFusion can only stop vFusion. The cap here counts what this install
spends and refuses to run flows past it — it does not and cannot limit
the Gemini key itself. Anything else holding that key keeps spending,
and a key stolen tomorrow is not bounded by a number in this database.

So the pairing matters and the UI says so: set this, and set a budget
on the Google Cloud project as well. This one is fast and precise about
vFusion's own usage; that one is the actual ceiling.

Month to date, not a rolling window, because a budget is a thing people
think about in months and a rolling 30 days never resets in a way you
can point at.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Run
from app.pricing import ledger
from app.settings_store import get_str


logger = logging.getLogger(__name__)

CAP_KEY = "spend_cap_usd"
ENABLED_KEY = "spend_cap_enabled"


def month_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def spend_since(session: AsyncSession, since: datetime) -> float:
    """Everything this install has spent on Gemini since a moment.

    Both halves: the cost each gemini step recorded on its run, and the
    ledger of calls that happen outside runs — composing, drafting,
    help, video. Counting only the first would let design work spend
    past a cap unnoticed, which is the half that has no rate limit on
    it at all.
    """
    total = 0.0
    rows = (
        await session.execute(select(Run.steps).where(Run.created_at >= since))
    ).all()
    for (steps,) in rows:
        for step in steps or []:
            out = step.get("output") if isinstance(step, dict) else None
            cost = out.get("cost") if isinstance(out, dict) else None
            if isinstance(cost, dict):
                total += float(cost.get("cost_usd") or 0)
    for entry in await ledger.since(since):
        total += float(entry.get("cost_usd") or 0)
    return round(total, 6)


async def cap() -> tuple[bool, float]:
    """(enabled, dollars). A cap of zero is off, not "spend nothing"."""
    enabled = (await get_str(ENABLED_KEY)) == "1"
    raw = await get_str(CAP_KEY)
    try:
        amount = float(raw) if raw else 0.0
    except (TypeError, ValueError):
        amount = 0.0
    return enabled and amount > 0, amount


async def state(session: AsyncSession) -> dict[str, Any]:
    enabled, amount = await cap()
    start = month_start()
    spent = await spend_since(session, start)
    return {
        "enabled": enabled,
        "cap_usd": amount,
        "spent_usd": spent,
        "since": start.isoformat(),
        "halted": bool(enabled and spent >= amount),
        "remaining_usd": round(max(0.0, amount - spent), 4) if enabled else None,
    }


async def should_halt(session: AsyncSession) -> str | None:
    """Why a flow must not run right now, or None.

    Checked at the moment a run starts rather than when it is queued: a
    queue drained after the cap was raised should run, and one drained
    after it was hit should not.
    """
    enabled, amount = await cap()
    if not enabled:
        return None
    spent = await spend_since(session, month_start())
    if spent < amount:
        return None
    return (
        f"Spending cap reached — ${spent:.2f} of ${amount:.2f} this month. "
        f"Flows are paused until the cap is raised or the month rolls over. "
        f"Nothing is disabled; they resume on their own."
    )
