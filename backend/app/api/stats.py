"""Skeleton stats API.

Aggregate counters + simple time-bucketed series for the Stats page.
Intentionally minimal — the long-term plan is a Gemini-key-backed
"billing usage / trend insights" view, but this first cut just covers
the deterministic stuff (counts, disk usage, type histograms) so the
page has something real to render today.
"""

import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psutil
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.footage import CLIP_ROOT
from app.db import get_session
from app.models import GeminiPricing, Run, WebhookAsset, WebhookEvent


router = APIRouter(prefix="/api/stats", tags=["stats"])


class TypeCount(BaseModel):
    label: str
    count: int
    # For "Top event types": tells the frontend whether the label is a
    # notification_type (default) or the outer webhook_type (lpr /
    # sensor_alert payloads which have no notification_type by spec).
    # "null" means neither was set — true junk traffic.
    label_source: str = "notification_type"


class PeriodCount(BaseModel):
    label: str
    count: int


class StorageBucket(BaseModel):
    label: str
    bytes: int
    file_count: int


class ModelSpend(BaseModel):
    model: str
    runs: int
    tokens_in: int
    tokens_out: int
    cost_usd: float


class PricingRow(BaseModel):
    model: str
    input_per_1m_usd: float
    output_per_1m_usd: float
    fetched_at: datetime


class StatsOverview(BaseModel):
    generated_at: datetime
    # Webhook ingest
    webhooks_total: int
    webhooks_last_24h: int
    webhooks_last_7d: int
    webhooks_last_30d: int
    webhooks_by_type: list[TypeCount]
    webhooks_by_family: list[TypeCount]
    # Flow execution
    runs_total: int
    runs_last_24h: int
    runs_success_rate: float | None
    # Disk
    storage: list[StorageBucket]
    storage_total_bytes: int
    # Gemini spend (estimated from published per-1M rates × usage_metadata
    # tokens captured on each run). Numbers are pre-discount, pre-credit.
    gemini_spend_30d_usd: float
    gemini_spend_by_model: list[ModelSpend]
    gemini_pricing: list[PricingRow]


def _dir_size(path: Path) -> tuple[int, int]:
    """Return (total bytes, file count) for ``path``, ignoring missing dirs."""
    if not path.exists():
        return (0, 0)
    total = 0
    count = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
                count += 1
        except OSError:
            continue
    return (total, count)


class SystemLoad(BaseModel):
    # All values are point-in-time samples from the container. Inside docker
    # these reflect the container's view (cgroup-aware in psutil), not the
    # host metal.
    cpu_percent: float
    cpu_count: int
    load_avg_1m: float | None
    load_avg_5m: float | None
    load_avg_15m: float | None
    mem_total_bytes: int
    mem_used_bytes: int
    mem_percent: float
    swap_used_bytes: int
    disk_total_bytes: int
    disk_used_bytes: int
    disk_percent: float
    process_rss_bytes: int
    process_threads: int
    uptime_seconds: float
    sampled_at: datetime


@router.get("/system", response_model=SystemLoad)
async def system_load() -> SystemLoad:
    # Non-blocking sample; first call after boot may report 0.0 because
    # psutil needs two snapshots to compute a delta. The Stats page polls
    # this on an interval so subsequent reads are accurate.
    cpu_pct = psutil.cpu_percent(interval=None)
    cpu_count = psutil.cpu_count(logical=True) or 1
    try:
        la1, la5, la15 = psutil.getloadavg()
    except (OSError, AttributeError):
        la1 = la5 = la15 = None
    vm = psutil.virtual_memory()
    sm = psutil.swap_memory()
    du = psutil.disk_usage("/")
    proc = psutil.Process()
    rss = proc.memory_info().rss
    threads = proc.num_threads()
    uptime = time.time() - psutil.boot_time()
    return SystemLoad(
        cpu_percent=float(cpu_pct),
        cpu_count=int(cpu_count),
        load_avg_1m=la1,
        load_avg_5m=la5,
        load_avg_15m=la15,
        mem_total_bytes=int(vm.total),
        mem_used_bytes=int(vm.used),
        mem_percent=float(vm.percent),
        swap_used_bytes=int(sm.used),
        disk_total_bytes=int(du.total),
        disk_used_bytes=int(du.used),
        disk_percent=float(du.percent),
        process_rss_bytes=int(rss),
        process_threads=int(threads),
        uptime_seconds=float(uptime),
        sampled_at=datetime.now(timezone.utc),
    )


@router.get("/overview", response_model=StatsOverview)
async def overview(session: AsyncSession = Depends(get_session)) -> StatsOverview:
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=30)

    # Webhook counters.
    webhooks_total = (await session.execute(
        select(func.count()).select_from(WebhookEvent)
    )).scalar_one()
    webhooks_24h = (await session.execute(
        select(func.count())
        .select_from(WebhookEvent)
        .where(WebhookEvent.received_at >= cutoff_24h)
    )).scalar_one()
    webhooks_7d = (await session.execute(
        select(func.count())
        .select_from(WebhookEvent)
        .where(WebhookEvent.received_at >= cutoff_7d)
    )).scalar_one()
    webhooks_30d = (await session.execute(
        select(func.count())
        .select_from(WebhookEvent)
        .where(WebhookEvent.received_at >= cutoff_30d)
    )).scalar_one()

    # Top event types: lpr / sensor_alert have no notification_type by
    # Verkada's spec — they're discriminated by webhook_type. We group on
    # both columns and then collapse so those events show under their own
    # label instead of dumping into "(unrecognized)" alongside true junk.
    by_type_rows = (await session.execute(
        select(
            WebhookEvent.notification_type,
            WebhookEvent.webhook_type,
            func.count(),
        )
        .group_by(WebhookEvent.notification_type, WebhookEvent.webhook_type)
        .order_by(func.count().desc())
        .limit(40)
    )).all()
    # Merge identical labels post-query (e.g. two rows with notification_type
    # NULL + webhook_type "lpr" should collapse to one "lpr" bucket).
    merged: dict[tuple[str, str], int] = {}
    for nt, wt, c in by_type_rows:
        if nt:
            key = ("notification_type", nt)
        elif wt:
            key = ("webhook_type", wt)
        else:
            key = ("null", "(unrecognized)")
        merged[key] = merged.get(key, 0) + int(c)
    by_type = [
        TypeCount(label=label, count=count, label_source=src)
        for (src, label), count in sorted(
            merged.items(), key=lambda kv: kv[1], reverse=True
        )[:20]
    ]

    by_family_rows = (await session.execute(
        select(WebhookEvent.family, func.count())
        .group_by(WebhookEvent.family)
        .order_by(func.count().desc())
    )).all()
    by_family = [
        TypeCount(label=row[0] or "(unknown)", count=int(row[1]))
        for row in by_family_rows
    ]

    # Run counters.
    runs_total = (await session.execute(
        select(func.count()).select_from(Run)
    )).scalar_one()
    runs_24h = (await session.execute(
        select(func.count())
        .select_from(Run)
        .where(Run.created_at >= cutoff_24h)
    )).scalar_one()
    runs_success_24h = (await session.execute(
        select(func.count())
        .select_from(Run)
        .where(Run.created_at >= cutoff_24h, Run.status == "success")
    )).scalar_one()
    success_rate: float | None = (
        runs_success_24h / runs_24h if runs_24h else None
    )

    # Disk usage. Webhook assets we track in the DB so we can also count
    # rows; clips live on the filesystem so we walk the dir.
    asset_size_row = (await session.execute(
        select(func.coalesce(func.sum(WebhookAsset.file_size), 0), func.count())
        .where(WebhookAsset.status == "ready")
    )).one()
    asset_bytes = int(asset_size_row[0] or 0)
    asset_count = int(asset_size_row[1] or 0)
    clip_bytes, clip_count = _dir_size(Path(CLIP_ROOT))
    storage = [
        StorageBucket(label="Webhook assets", bytes=asset_bytes, file_count=asset_count),
        StorageBucket(label="Gemini clips", bytes=clip_bytes, file_count=clip_count),
    ]
    storage_total = sum(b.bytes for b in storage)

    # Gemini spend: walk recent runs, sum the cost dicts each gemini_*
    # step recorded onto its output. We don't try to recompute from raw
    # token counts here — the action already did that with the live
    # pricing table at the time of the run, which keeps historical costs
    # stable even if Google moves prices later.
    spend_rows = (await session.execute(
        select(Run.steps, Run.created_at).where(Run.created_at >= cutoff_30d)
    )).all()
    by_model: dict[str, ModelSpend] = {}
    total_30d = 0.0
    for steps, _created in spend_rows:
        for s in steps or []:
            out = s.get("output") if isinstance(s, dict) else None
            cost = out.get("cost") if isinstance(out, dict) else None
            if not isinstance(cost, dict):
                continue
            model = str(cost.get("model") or s.get("type") or "unknown")
            cost_usd = float(cost.get("cost_usd") or 0)
            t_in = int(cost.get("tokens_in") or 0)
            t_out = int(cost.get("tokens_out") or 0)
            total_30d += cost_usd
            if model not in by_model:
                by_model[model] = ModelSpend(
                    model=model, runs=0, tokens_in=0, tokens_out=0, cost_usd=0.0
                )
            entry = by_model[model]
            entry.runs += 1
            entry.tokens_in += t_in
            entry.tokens_out += t_out
            entry.cost_usd += cost_usd
    spend_by_model = sorted(
        by_model.values(), key=lambda m: m.cost_usd, reverse=True
    )

    pricing_rows = (await session.execute(
        select(GeminiPricing).order_by(GeminiPricing.model.asc())
    )).scalars().all()
    pricing = [
        PricingRow(
            model=p.model,
            input_per_1m_usd=float(p.input_per_1m_usd),
            output_per_1m_usd=float(p.output_per_1m_usd),
            fetched_at=p.fetched_at,
        )
        for p in pricing_rows
    ]

    return StatsOverview(
        generated_at=now,
        webhooks_total=webhooks_total,
        webhooks_last_24h=webhooks_24h,
        webhooks_last_7d=webhooks_7d,
        webhooks_last_30d=webhooks_30d,
        webhooks_by_type=by_type,
        webhooks_by_family=by_family,
        runs_total=runs_total,
        runs_last_24h=runs_24h,
        runs_success_rate=success_rate,
        storage=storage,
        storage_total_bytes=storage_total,
        gemini_spend_30d_usd=round(total_30d, 4),
        gemini_spend_by_model=spend_by_model,
        gemini_pricing=pricing,
    )
