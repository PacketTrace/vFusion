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
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.footage import CLIP_ROOT
from app.db import get_session
from app.models import Run, WebhookAsset, WebhookEvent


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


class WebhookBreakdown(BaseModel):
    """The two webhook charts, and nothing else.

    Split out of /overview because it is read from a different place now
    -- the Webhooks tab, which polls it -- and overview is expensive in
    a way that has nothing to do with webhooks: it walks the clips
    directory on disk to size it. Polling that every thirty seconds to
    draw two bar charts is a filesystem scan for no reason.
    """

    generated_at: datetime
    by_type: list[TypeCount]
    by_family: list[TypeCount]
    # Echoed back rather than assumed, so the charts label themselves
    # from the data they are actually drawing. What was asked for and
    # what is on screen disagree for one render on every filter change,
    # which is exactly when somebody is reading the number.
    #
    # Called "range" rather than "window" to match the audit page, and
    # because "window" shadows the global of that name in the component
    # reading it.
    range: str = "all"
    family: str | None = None
    # Denominator for the share on each bar. Deliberately not the
    # all-time total: a share of the wrong total is worse than none.
    total: int = 0


class StatsOverview(BaseModel):
    generated_at: datetime
    # Webhook ingest
    webhooks_total: int
    webhooks_last_24h: int
    webhooks_last_7d: int
    webhooks_last_30d: int
    # Flow execution
    runs_total: int
    runs_last_24h: int
    runs_success_rate: float | None
    # Disk
    storage: list[StorageBucket]
    storage_total_bytes: int


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


# How far back the two webhook breakdowns look. The tiles are fixed
# windows by definition and ignore this; the charts did not previously
# have a window at all, which meant they answered "what has ever
# happened here" forever -- a question that stops changing after a month
# and cannot tell you what broke this morning.
WINDOWS: dict[str, timedelta] = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}

# The label the UI shows for events whose family never resolved. Sent
# back as a filter value too, so clicking that bar narrows to it.
UNKNOWN_FAMILY = "(unknown)"


@router.get("/webhooks", response_model=WebhookBreakdown)
async def webhook_breakdown(
    session: AsyncSession = Depends(get_session),
    range: str = Query("all", description="24h | 7d | 30d | all"),
    family: str | None = Query(
        None, description="Narrow the event-type breakdown to one family"
    ),
) -> WebhookBreakdown:
    """What arrived, by family and by type, over a window.

    These used to have no window at all: they counted every webhook ever
    received, which is an answer that stops changing after a month and
    can never say what broke this morning.
    """
    now = datetime.now(timezone.utc)

    # An unrecognised range is "all" rather than a 422. This is a
    # dashboard reading its own URL, and a bad query string should show
    # you the page rather than an error you cannot act on.
    rng = range if range in WINDOWS or range == "all" else "all"
    cutoff = now - WINDOWS[rng] if rng in WINDOWS else None

    def _windowed(stmt):
        return stmt.where(WebhookEvent.received_at >= cutoff) if cutoff else stmt

    # The family filter narrows the event types and never the family
    # chart itself: filtering a chart by a value read off that same
    # chart leaves one bar and no way back to the others.
    def _family_filtered(stmt):
        if family is None:
            return stmt
        if family == UNKNOWN_FAMILY:
            return stmt.where(WebhookEvent.family.is_(None))
        return stmt.where(WebhookEvent.family == family)

    # Top event types: lpr / sensor_alert have no notification_type by
    # Verkada's spec — they're discriminated by webhook_type. We group on
    # both columns and then collapse so those events show under their own
    # label instead of dumping into "(unrecognized)" alongside true junk.
    by_type_rows = (await session.execute(
        _family_filtered(_windowed(
            select(
                WebhookEvent.notification_type,
                WebhookEvent.webhook_type,
                func.count(),
            )
        ))
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
        _windowed(select(WebhookEvent.family, func.count()))
        .group_by(WebhookEvent.family)
        .order_by(func.count().desc())
    )).all()
    by_family = [
        TypeCount(label=row[0] or UNKNOWN_FAMILY, count=int(row[1]))
        for row in by_family_rows
    ]
    # The share denominator: every webhook in the window, whatever its
    # family. Summing the family rows gives the same number and costs
    # nothing, where a fourth COUNT(*) would cost a scan.
    webhooks_in_window = sum(r.count for r in by_family)

    return WebhookBreakdown(
        generated_at=now,
        by_type=by_type,
        by_family=by_family,
        range=rng,
        family=family,
        total=webhooks_in_window,
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

    return StatsOverview(
        generated_at=now,
        webhooks_total=webhooks_total,
        webhooks_last_24h=webhooks_24h,
        webhooks_last_7d=webhooks_7d,
        webhooks_last_30d=webhooks_30d,
        runs_total=runs_total,
        runs_last_24h=runs_24h,
        runs_success_rate=success_rate,
        storage=storage,
        storage_total_bytes=storage_total,
    )
