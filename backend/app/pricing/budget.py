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
from uuid import UUID

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


async def breakdown(session: AsyncSession, since: datetime) -> dict[str, Any]:
    """Where the money went, and what is missing from the record.

    Three things, because "what costs most" and "is anything not being
    counted" are the same question asked from opposite ends:

    * every declared source with its total, **including zeros** — a
      feature you have used that still reads nothing is not free, it is
      uninstrumented;
    * spend per flow, since "which flow" is the actionable form of
      "which of these is expensive";
    * anything recorded under a name not in the registry, which catches
      the same drift from the other side.
    """
    from app.models import Flow
    from app.pricing import sources as src

    totals: dict[str, float] = {s.name: 0.0 for s in src.SOURCES}
    calls: dict[str, int] = {s.name: 0 for s in src.SOURCES}
    unregistered: dict[str, float] = {}

    for entry in await ledger.since(since):
        name = str(entry.get("source") or "unknown")
        cost = float(entry.get("cost_usd") or 0)
        if name in totals:
            totals[name] += cost
            calls[name] += 1
        else:
            unregistered[name] = unregistered.get(name, 0.0) + cost

    # Flow spend comes off the runs, not the ledger — each gemini step
    # records its own cost — so it is summed separately and attributed
    # to the flow that ran it.
    per_flow: dict[str, dict[str, Any]] = {}
    rows = (
        await session.execute(
            select(Run.flow_id, Run.steps).where(Run.created_at >= since)
        )
    ).all()
    for flow_id, steps in rows:
        for step in steps or []:
            out = step.get("output") if isinstance(step, dict) else None
            cost = out.get("cost") if isinstance(out, dict) else None
            if not isinstance(cost, dict):
                continue
            amount = float(cost.get("cost_usd") or 0)
            totals[src.FLOW_RUN] += amount
            calls[src.FLOW_RUN] += 1
            key = str(flow_id)
            row = per_flow.setdefault(key, {"flow_id": key, "name": None, "cost_usd": 0.0, "steps": 0})
            row["cost_usd"] += amount
            row["steps"] += 1

    if per_flow:
        names = (
            await session.execute(
                select(Flow.id, Flow.name).where(
                    Flow.id.in_([UUID(k) for k in per_flow])
                )
            )
        ).all()
        for fid, name in names:
            if str(fid) in per_flow:
                per_flow[str(fid)]["name"] = name

    return {
        "sources": [
            {
                "name": s.name,
                "what": s.what,
                "token_priced": s.token_priced,
                "cost_usd": round(totals[s.name], 6),
                "calls": calls[s.name],
            }
            for s in sorted(src.SOURCES, key=lambda x: -totals[x.name])
        ],
        "flows": sorted(
            per_flow.values(), key=lambda r: -float(r["cost_usd"])
        )[:15],
        "unregistered": [
            {"name": k, "cost_usd": round(v, 6)} for k, v in unregistered.items()
        ],
    }
