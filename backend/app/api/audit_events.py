"""Explorer → Audit log. Reads ``audit_events`` only; never Verkada.

Every endpoint takes the same filter set (see ``_filters``) so the list,
the facet counts, the charts and the CSV export all describe the same
slice. ``include_self`` is off by default: requests made with vFusion's
own key are most of a working org's log and rarely the question.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import Integer, String, and_, case, cast, desc, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import ingest
from app.audit.taxonomy import CATEGORIES
from app.db import SessionLocal, get_session
from app.models import AuditEvent

router = APIRouter(prefix="/api/audit-events", tags=["audit-events"])

MAX_LIMIT = 200
EXPORT_LIMIT = 50_000
FACET_LIMIT = 15


# ---- filters --------------------------------------------------------------


def _parse_when(value: str | None, *, name: str) -> datetime | None:
    if not value:
        return None
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            return datetime.fromtimestamp(float(s), tz=timezone.utc)
        except ValueError:
            raise HTTPException(400, f"{name} must be ISO 8601 or epoch seconds") from None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class Filters:
    """One object so the four endpoints cannot drift apart."""

    def __init__(
        self,
        q: str | None = Query(default=None, description="substring across everything"),
        since: str | None = Query(default=None),
        until: str | None = Query(default=None),
        category: list[str] = Query(default=[]),
        event_name: list[str] = Query(default=[]),
        actor: list[str] = Query(default=[]),
        user: str | None = Query(default=None, description="email, name, id or key name"),
        ip: str | None = Query(default=None),
        api_key: list[str] = Query(default=[]),
        method: list[str] = Query(default=[]),
        status: list[str] = Query(default=[], description="200, 404 or a class like 4xx"),
        url: str | None = Query(default=None),
        device_type: list[str] = Query(default=[]),
        device_id: str | None = Query(default=None),
        device: str | None = Query(default=None, description="device name substring"),
        site: list[str] = Query(default=[]),
        include_self: bool = Query(default=False),
        connection_id: UUID | None = Query(default=None),
    ) -> None:
        now = datetime.now(timezone.utc)
        self.until = _parse_when(until, name="until") or now
        self.since = _parse_when(since, name="since") or (self.until - timedelta(hours=24))
        if self.since >= self.until:
            raise HTTPException(400, "since must be before until")
        self.q = (q or "").strip().lower() or None
        self.category = [c for c in category if c]
        self.event_name = [e for e in event_name if e]
        self.actor = [a for a in actor if a]
        self.user = (user or "").strip() or None
        self.ip = (ip or "").strip() or None
        self.api_key = [k for k in api_key if k]
        self.method = [m.upper() for m in method if m]
        self.status = [s for s in status if s]
        self.url = (url or "").strip() or None
        self.device_type = [d for d in device_type if d]
        self.device_id = (device_id or "").strip() or None
        self.device = (device or "").strip() or None
        self.site = [s for s in site if s]
        self.include_self = include_self
        self.connection_id = connection_id

    def conditions(self, *, self_clause: bool = True) -> list[Any]:
        A = AuditEvent
        conds: list[Any] = [A.timestamp >= self.since, A.timestamp < self.until]
        if self_clause and not self.include_self:
            conds.append(A.is_self.is_(False))
        if self.connection_id:
            conds.append(A.connection_id == self.connection_id)
        if self.q:
            conds.append(A.search_text.ilike(f"%{_esc(self.q)}%", escape="\\"))
        if self.category:
            conds.append(A.category.in_(self.category))
        if self.event_name:
            conds.append(A.event_name.in_(self.event_name))
        if self.actor:
            conds.append(A.actor.in_(self.actor))
        if self.user:
            p = f"%{_esc(self.user)}%"
            conds.append(
                or_(
                    A.user_email.ilike(p, escape="\\"),
                    A.user_name.ilike(p, escape="\\"),
                    A.user_id == self.user,
                    A.api_key_name.ilike(p, escape="\\"),
                )
            )
        if self.ip:
            conds.append(A.ip_address == self.ip)
        if self.api_key:
            conds.append(A.api_key_name.in_(self.api_key))
        if self.method:
            conds.append(A.method.in_(self.method))
        if self.status:
            exact: list[int] = []
            classes: list[Any] = []
            for s in self.status:
                s = s.strip().lower()
                if s.endswith("xx") and s[:-2].isdigit():
                    lo = int(s[:-2]) * 100
                    classes.append(and_(A.status_code >= lo, A.status_code < lo + 100))
                elif s.isdigit():
                    exact.append(int(s))
            parts: list[Any] = list(classes)
            if exact:
                parts.append(A.status_code.in_(exact))
            if parts:
                conds.append(or_(*parts))
        if self.url:
            conds.append(A.url_path.ilike(f"%{_esc(self.url)}%", escape="\\"))
        if self.device_type:
            conds.append(A.device_type.in_(self.device_type))
        if self.device_id:
            conds.append(A.device_id == self.device_id)
        if self.device:
            conds.append(A.device_name.ilike(f"%{_esc(self.device)}%", escape="\\"))
        if self.site:
            conds.append(A.device_site.in_(self.site))
        return conds


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ---- shapes ---------------------------------------------------------------


class AuditEventListItem(BaseModel):
    id: UUID
    timestamp: datetime
    event_name: str
    category: str
    actor: str
    user_name: str | None
    user_email: str | None
    ip_address: str | None
    api_key_name: str | None
    method: str | None
    url_path: str | None
    status_code: int | None
    is_self: bool
    device_name: str | None
    device_type: str | None
    device_site: str | None
    device_count: int

    model_config = {"from_attributes": True}


class AuditEventOut(AuditEventListItem):
    processed_at: datetime | None
    ingested_at: datetime
    event_description: str | None
    user_id: str | None
    org_id: str | None
    api_key_tail: str | None
    response_size: int | None
    device_id: str | None
    devices: list
    details: dict
    raw: dict


class AuditEventList(BaseModel):
    items: list[AuditEventListItem]
    total: int
    since: datetime
    until: datetime


class FacetValue(BaseModel):
    value: str
    label: str | None = None
    count: int


class Facets(BaseModel):
    total: int
    category: list[FacetValue]
    event_name: list[FacetValue]
    actor: list[FacetValue]
    user: list[FacetValue]
    api_key: list[FacetValue]
    method: list[FacetValue]
    status: list[FacetValue]
    device_type: list[FacetValue]
    site: list[FacetValue]
    device: list[FacetValue]
    ip: list[FacetValue]
    self_hidden: int


# ---- endpoints ------------------------------------------------------------


@router.get("/categories")
async def categories() -> list[dict[str, str]]:
    return [{"key": k, "label": v} for k, v in CATEGORIES.items()]


@router.get("", response_model=AuditEventList)
async def list_events(
    f: Filters = Depends(),
    limit: int = Query(default=100, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> AuditEventList:
    conds = f.conditions()
    total = (
        await session.execute(select(func.count()).select_from(AuditEvent).where(*conds))
    ).scalar() or 0
    rows = (
        await session.execute(
            select(AuditEvent)
            .where(*conds)
            .order_by(desc(AuditEvent.timestamp), desc(AuditEvent.ingested_at))
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()
    return AuditEventList(
        items=[AuditEventListItem.model_validate(r) for r in rows],
        total=int(total),
        since=f.since,
        until=f.until,
    )


@router.get("/status")
async def poll_status() -> dict[str, Any]:
    return await ingest.status()


@router.post("/poll")
async def poll_now() -> dict[str, Any]:
    """One tick, inline. The worker does this every ten seconds; this is
    for a fresh install that wants to see something now."""
    await ingest.tick_all(budget_sec=15.0)
    return await ingest.status()


class BackfillIn(BaseModel):
    days: int


@router.post("/backfill")
async def backfill(body: BackfillIn) -> dict[str, Any]:
    if body.days < 1 or body.days > 365:
        raise HTTPException(400, "days must be between 1 and 365")
    await ingest.request_backfill(body.days)
    return await ingest.status()


@router.get("/facets", response_model=Facets)
async def facets(
    f: Filters = Depends(),
    session: AsyncSession = Depends(get_session),
) -> Facets:
    A = AuditEvent
    conds = f.conditions()

    async def top(col: Any, *, label: Any | None = None, where: list[Any] | None = None) -> list[FacetValue]:
        cols = [col.label("v"), func.count().label("n")]
        if label is not None:
            cols.insert(1, label.label("l"))
        # ``label`` is an aggregate (max of a companion column), so the
        # grouping is by the value alone.
        stmt = (
            select(*cols)
            .where(*conds, *(where or []), col.isnot(None))
            .group_by(col)
            .order_by(desc("n"))
            .limit(FACET_LIMIT)
        )
        out: list[FacetValue] = []
        for row in (await session.execute(stmt)).all():
            if label is not None:
                v, l, n = row
                out.append(FacetValue(value=str(v), label=str(l) if l is not None else None, count=int(n)))
            else:
                v, n = row
                out.append(FacetValue(value=str(v), count=int(n)))
        return out

    total = (
        await session.execute(select(func.count()).select_from(A).where(*conds))
    ).scalar() or 0
    # How many rows the self filter is hiding from this exact slice.
    self_hidden = 0
    if not f.include_self:
        self_hidden = (
            await session.execute(
                select(func.count())
                .select_from(A)
                .where(*f.conditions(self_clause=False), A.is_self.is_(True))
            )
        ).scalar() or 0

    user_key = func.coalesce(A.user_email, A.user_name, A.api_key_name)
    status_class = case(
        (A.status_code.is_(None), None),
        else_=func.concat(cast(A.status_code / 100, Integer), literal("xx")),
    )
    return Facets(
        total=int(total),
        category=await top(A.category),
        event_name=await top(A.event_name),
        actor=await top(A.actor),
        user=await top(user_key, label=func.max(A.user_name)),
        api_key=await top(A.api_key_name),
        method=await top(A.method),
        status=await top(cast(A.status_code, String)),
        device_type=await top(A.device_type),
        site=await top(A.device_site),
        device=await top(A.device_name, label=func.max(A.device_type)),
        ip=await top(A.ip_address),
        self_hidden=int(self_hidden),
    )


def _bucket_seconds(since: datetime, until: datetime) -> int:
    span = (until - since).total_seconds()
    if span <= 2 * 3600:
        return 60
    if span <= 12 * 3600:
        return 300
    if span <= 3 * 86400:
        return 3600
    if span <= 60 * 86400:
        return 86400
    return 7 * 86400


@router.get("/stats")
async def stats(
    f: Filters = Depends(),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """The Insights tab. Everything here is a group-by over the same
    slice the list shows, so a bar can always be clicked into rows."""
    A = AuditEvent
    conds = f.conditions()
    bucket = _bucket_seconds(f.since, f.until)
    epoch = func.extract("epoch", A.timestamp)
    slot = (func.floor(epoch / bucket) * bucket).label("slot")

    # Totals.
    tot = (
        await session.execute(
            select(
                func.count(),
                func.count(func.distinct(func.coalesce(A.user_email, A.user_name))),
                func.count(func.distinct(A.ip_address)),
                func.count(func.distinct(A.device_id)),
                func.sum(case((A.status_code >= 400, 1), else_=0)),
                func.sum(case((A.category == "api", 1), else_=0)),
            ).where(*conds)
        )
    ).one()
    self_hidden = 0
    if not f.include_self:
        self_hidden = (
            await session.execute(
                select(func.count())
                .select_from(A)
                .where(*f.conditions(self_clause=False), A.is_self.is_(True))
            )
        ).scalar() or 0
    totals = {
        "self_hidden": int(self_hidden),
        "events": int(tot[0] or 0),
        "users": int(tot[1] or 0),
        "ips": int(tot[2] or 0),
        "devices": int(tot[3] or 0),
        "errors": int(tot[4] or 0),
        "api_requests": int(tot[5] or 0),
    }

    # Which categories get their own series.
    cat_rows = (
        await session.execute(
            select(A.category, func.count().label("n"))
            .where(*conds)
            .group_by(A.category)
            .order_by(desc("n"))
        )
    ).all()
    cat_totals = [{"category": c, "count": int(n)} for c, n in cat_rows]

    # Real categories, not "top N + other": the page owns the colour
    # slots, and a colour has to follow the category, never its rank.
    ts_rows = (
        await session.execute(
            select(slot, A.category.label("c"), func.count().label("n"))
            .where(*conds)
            .group_by("slot", "c")
            .order_by("slot")
        )
    ).all()
    by_slot: dict[int, dict[str, int]] = {}
    for s, c, n in ts_rows:
        by_slot.setdefault(int(s), {})[str(c)] = int(n)
    # Fill empty buckets so the chart shows silence as silence.
    first = int(f.since.timestamp() // bucket * bucket)
    last = int(f.until.timestamp() // bucket * bucket)
    timeseries = []
    t = first
    while t <= last:
        counts = by_slot.get(t, {})
        timeseries.append({"t": t, "total": sum(counts.values()), "by_category": counts})
        t += bucket

    # Users: what each spends their time doing.
    user_key = func.coalesce(A.user_email, A.user_name, A.api_key_name, A.actor)
    user_rows = (
        await session.execute(
            select(
                user_key.label("u"),
                func.max(A.user_name).label("name"),
                func.max(A.actor).label("actor"),
                func.count().label("n"),
                func.count(func.distinct(A.ip_address)).label("ips"),
                func.min(A.timestamp).label("first"),
                func.max(A.timestamp).label("last"),
            )
            .where(*conds)
            .group_by("u")
            .order_by(desc("n"))
            .limit(12)
        )
    ).all()
    user_keys = [r[0] for r in user_rows]
    breakdown: dict[str, list[dict[str, Any]]] = {u: [] for u in user_keys}
    if user_keys:
        br_rows = (
            await session.execute(
                select(user_key.label("u"), A.event_name, A.category, func.count().label("n"))
                .where(*conds, user_key.in_(user_keys))
                .group_by("u", A.event_name, A.category)
                .order_by(desc("n"))
            )
        ).all()
        for u, ev, cat, n in br_rows:
            lst = breakdown.setdefault(str(u), [])
            if len(lst) < 8:
                lst.append({"event_name": ev, "category": cat, "count": int(n)})
    users = [
        {
            "key": str(u),
            "name": name,
            "actor": actor,
            "count": int(n),
            "ips": int(ips),
            "first": first_.isoformat() if first_ else None,
            "last": last_.isoformat() if last_ else None,
            "top": breakdown.get(str(u), []),
        }
        for u, name, actor, n, ips, first_, last_ in user_rows
    ]

    events = [
        {"event_name": ev, "category": cat, "count": int(n)}
        for ev, cat, n in (
            await session.execute(
                select(A.event_name, func.max(A.category), func.count().label("n"))
                .where(*conds)
                .group_by(A.event_name)
                .order_by(desc("n"))
                .limit(15)
            )
        ).all()
    ]

    endpoints = [
        {
            "method": m,
            "url": u,
            "count": int(n),
            "errors": int(e or 0),
            "keys": int(k or 0),
        }
        for m, u, n, e, k in (
            await session.execute(
                select(
                    A.method,
                    A.url_path,
                    func.count().label("n"),
                    func.sum(case((A.status_code >= 400, 1), else_=0)),
                    func.count(func.distinct(A.api_key_name)),
                )
                .where(*conds, A.url_path.isnot(None))
                .group_by(A.method, A.url_path)
                .order_by(desc("n"))
                .limit(15)
            )
        ).all()
    ]

    keys = [
        {"api_key_name": k, "count": int(n), "errors": int(e or 0), "ips": int(i or 0), "last": last_.isoformat() if last_ else None}
        for k, n, e, i, last_ in (
            await session.execute(
                select(
                    A.api_key_name,
                    func.count().label("n"),
                    func.sum(case((A.status_code >= 400, 1), else_=0)),
                    func.count(func.distinct(A.ip_address)),
                    func.max(A.timestamp),
                )
                .where(*conds, A.api_key_name.isnot(None))
                .group_by(A.api_key_name)
                .order_by(desc("n"))
                .limit(10)
            )
        ).all()
    ]

    statuses = [
        {"status": int(s), "count": int(n)}
        for s, n in (
            await session.execute(
                select(A.status_code, func.count().label("n"))
                .where(*conds, A.status_code.isnot(None))
                .group_by(A.status_code)
                .order_by(desc("n"))
                .limit(12)
            )
        ).all()
    ]

    ips = [
        {"ip": ip, "count": int(n), "users": int(u or 0), "last": last_.isoformat() if last_ else None}
        for ip, n, u, last_ in (
            await session.execute(
                select(
                    A.ip_address,
                    func.count().label("n"),
                    func.count(func.distinct(func.coalesce(A.user_email, A.api_key_name))),
                    func.max(A.timestamp),
                )
                .where(*conds, A.ip_address.isnot(None))
                .group_by(A.ip_address)
                .order_by(desc("n"))
                .limit(10)
            )
        ).all()
    ]

    devices = [
        {"device_id": did, "name": name, "type": typ, "site": site, "count": int(n)}
        for did, name, typ, site, n in (
            await session.execute(
                select(
                    A.device_id,
                    func.max(A.device_name),
                    func.max(A.device_type),
                    func.max(A.device_site),
                    func.count().label("n"),
                )
                .where(*conds, A.device_id.isnot(None))
                .group_by(A.device_id)
                .order_by(desc("n"))
                .limit(10)
            )
        ).all()
    ]

    # Day-of-week × hour, in UTC. The page shifts to the viewer's zone.
    dow = func.extract("dow", A.timestamp)
    hour = func.extract("hour", A.timestamp)
    heat = [
        {"dow": int(d), "hour": int(h), "count": int(n)}
        for d, h, n in (
            await session.execute(
                select(dow, hour, func.count()).where(*conds).group_by(dow, hour)
            )
        ).all()
    ]

    return {
        "since": f.since.isoformat(),
        "until": f.until.isoformat(),
        "bucket_sec": bucket,
        "totals": totals,
        "categories": cat_totals,
        "timeseries": timeseries,
        "users": users,
        "events": events,
        "endpoints": endpoints,
        "keys": keys,
        "statuses": statuses,
        "ips": ips,
        "devices": devices,
        "heatmap": heat,
    }


@router.get("/export")
async def export_csv(f: Filters = Depends()) -> StreamingResponse:
    """Streamed, so a 50,000-row export never sits in memory. Opens its
    own session: the request-scoped one can be closed before a
    streaming body finishes."""
    conds = f.conditions()
    columns = [
        "timestamp", "event_name", "category", "actor", "user_name", "user_email",
        "ip_address", "api_key_name", "method", "url_path", "status_code",
        "device_name", "device_type", "device_site", "event_description", "details",
    ]

    async def gen():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(columns)
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate()
        stmt = (
            select(AuditEvent)
            .where(*conds)
            .order_by(desc(AuditEvent.timestamp))
            .limit(EXPORT_LIMIT)
            .execution_options(yield_per=500)
        )
        async with SessionLocal() as session:
            result = await session.stream_scalars(stmt)
            async for r in result:
                w.writerow([
                    r.timestamp.isoformat(), r.event_name, r.category, r.actor, r.user_name,
                    r.user_email, r.ip_address, r.api_key_name, r.method, r.url_path,
                    r.status_code, r.device_name, r.device_type, r.device_site,
                    r.event_description, _json_compact(r.details),
                ])
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()

    name = f"audit-log_{f.since:%Y%m%d-%H%M}_{f.until:%Y%m%d-%H%M}.csv"
    return StreamingResponse(
        gen(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


def _json_compact(value: Any) -> str:
    import json

    try:
        return json.dumps(value, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return str(value)


@router.get("/{event_id}", response_model=AuditEventOut)
async def get_event(
    event_id: UUID, session: AsyncSession = Depends(get_session)
) -> AuditEventOut:
    row = await session.get(AuditEvent, event_id)
    if row is None:
        raise HTTPException(404, "audit event not found")
    return AuditEventOut.model_validate(row)
