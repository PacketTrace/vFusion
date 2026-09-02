"""Sample trigger fields for the variable picker UI.

Given a (family, notification_type), returns a flat list of every
templatable path the user could reference, with a real sample value
pulled from the most recent matching webhook. Paths are returned in
the shape templates expect: ``trigger.data.person_label``,
``trigger.org_id``, etc.
"""

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import WebhookEvent


router = APIRouter(prefix="/api/triggers", tags=["triggers"])


class TriggerField(BaseModel):
    path: str
    sample: Any
    type: str


def _flatten(value: Any, prefix: str, out: list[TriggerField]) -> None:
    """Walk a JSON value and emit (path, sample, type) for each scalar leaf."""
    if isinstance(value, dict):
        for k, v in value.items():
            child = f"{prefix}.{k}" if prefix else k
            _flatten(v, child, out)
    elif isinstance(value, list):
        # Show the array as a single entry with its length so the user knows it's there.
        out.append(
            TriggerField(path=prefix, sample=f"<array of {len(value)}>", type="array")
        )
        # Also walk the first element with [0] notation so nested fields are reachable.
        if value:
            _flatten(value[0], f"{prefix}.0", out)
    else:
        out.append(
            TriggerField(path=prefix, sample=value, type=type(value).__name__)
        )


# Samples that carry no useful info — frontend hides these as filter
# targets anyway, so we want a non-null sample to "win" over them if any
# other recent webhook has one.
_NULL_SAMPLES: tuple[Any, ...] = (None, "", "<array of 0>")


def _useful_sample(f: TriggerField) -> bool:
    return f.sample not in _NULL_SAMPLES


@router.get("/sample-fields", response_model=list[TriggerField])
async def sample_fields(
    family: str | None = Query(default=None),
    notification_type: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[TriggerField]:
    """Return every field path seen across the last ~20 matching webhooks.

    Verkada payloads vary inside a single notification_type — e.g.
    ``data.objects`` is populated on some ``alert_rule_motion`` fires and
    absent on others. Sampling only the most recent webhook would hide
    those fields from the filter picker, so we merge across recent
    events: any path that appears in any of them shows up, with the
    newest non-null sample winning as the value preview.
    """
    q = select(WebhookEvent).where(WebhookEvent.body_json.is_not(None))
    if family:
        q = q.where(WebhookEvent.family == family)
    if notification_type:
        q = q.where(WebhookEvent.notification_type == notification_type)
    q = q.order_by(desc(WebhookEvent.received_at)).limit(20)
    rows = (await session.execute(q)).scalars().all()

    # newest-first iteration → first non-null sample for each path wins.
    by_path: dict[str, TriggerField] = {}
    for row in rows:
        if not isinstance(row.body_json, dict):
            continue
        flat: list[TriggerField] = []
        _flatten(row.body_json, "trigger", flat)
        for f in flat:
            existing = by_path.get(f.path)
            if existing is None:
                by_path[f.path] = f
                continue
            # Upgrade a null/empty placeholder to a real value when we
            # find one further back in the history.
            if not _useful_sample(existing) and _useful_sample(f):
                by_path[f.path] = f

    out = list(by_path.values())
    # Sort: envelope fields first, then data.*, then everything else.
    def _rank(f: TriggerField) -> tuple[int, str]:
        p = f.path
        if p.startswith("trigger.data.") and p.count(".") == 2:
            return (1, p)
        if p.startswith("trigger.data."):
            return (2, p)
        if p.startswith("trigger.") and p.count(".") == 1:
            return (0, p)
        return (3, p)
    out.sort(key=_rank)
    return out


# ---------------------------------------------------------------------------
# Filter-field profiling
#
# The trigger filter picker used to offer a fixed per-family list — camera
# always got objects / person_label / license_plate_number / camera_id. That
# is wrong for most event types: `objects` is meaningless on camera_status,
# `person_label` on a crowd alert. And Verkada payloads carry noise, so a
# field appearing once in a thousand events shouldn't rank next to one
# present every time.
#
# So profile what actually arrives: for a given notification_type, how often
# each data.* field is populated, and which values it takes. Presence rate is
# the signal that separates a real filter from noise; observed values turn a
# free-text box into a picker.
# ---------------------------------------------------------------------------

# Fields that identify a specific event or moment rather than a class of
# them — filtering on these matches exactly one webhook, which is never
# what a trigger wants.
_NOT_FILTERABLE = {
    "event_id",
    "created",
    "start_timestamp",
    "end_timestamp",
    "answered_timestamp",
    "image_url",
    "video_url",
    "crop",
    "detected",
    "confidence",
    "alert_event_id",
    "uuid",
}

# Above this many distinct values, offering a dropdown is pointless — it's
# an id or a timestamp, not a category.
_MAX_DISTINCT_FOR_PICKER = 25


class FilterFieldProfile(BaseModel):
    field: str
    present: int
    sample_size: int
    present_pct: float
    # Distinct values seen, most common first. Empty when the field is
    # high-cardinality (ids, plates) — the UI falls back to free text.
    values: list[Any]
    distinct_count: int
    type: str


@router.get("/filter-fields", response_model=list[FilterFieldProfile])
async def filter_fields(
    family: str | None = Query(default=None),
    notification_type: str | None = Query(default=None),
    limit: int = Query(default=400, le=2000),
    session: AsyncSession = Depends(get_session),
) -> list[FilterFieldProfile]:
    """Which data.* fields are worth filtering on for this event type.

    Ranked by how often they're actually populated. Rare fields are still
    returned — a Person of Interest event really can carry a stray LPR
    field — so the UI can show them as rare rather than pretend they don't
    exist.
    """
    q = select(WebhookEvent).where(WebhookEvent.body_json.is_not(None))
    if family:
        q = q.where(WebhookEvent.family == family)
    if notification_type:
        q = q.where(WebhookEvent.notification_type == notification_type)
    q = q.order_by(desc(WebhookEvent.received_at)).limit(limit)
    rows = (await session.execute(q)).scalars().all()

    total = 0
    present: dict[str, int] = {}
    values: dict[str, dict[str, int]] = {}
    types: dict[str, str] = {}

    for row in rows:
        body = row.body_json if isinstance(row.body_json, dict) else {}
        data = body.get("data") if isinstance(body.get("data"), dict) else None
        if data is None:
            continue
        total += 1
        for key, raw in data.items():
            if key in _NOT_FILTERABLE:
                continue
            # A key that's present but null tells us nothing to match on.
            if raw is None or raw == "" or raw == []:
                continue
            # Objects arrive as a list; each entry is independently
            # filterable, which is what makes objects=animal work.
            if isinstance(raw, list):
                types.setdefault(key, "array")
                present[key] = present.get(key, 0) + 1
                bucket = values.setdefault(key, {})
                for item in raw:
                    label = (
                        item.get("type") or item.get("label")
                        if isinstance(item, dict)
                        else item
                    )
                    if label is None:
                        continue
                    bucket[str(label)] = bucket.get(str(label), 0) + 1
                continue
            if isinstance(raw, dict):
                # Nested objects (door_info, user_info) aren't matched
                # whole; the engine compares scalars.
                continue
            types.setdefault(key, type(raw).__name__)
            present[key] = present.get(key, 0) + 1
            bucket = values.setdefault(key, {})
            bucket[str(raw)] = bucket.get(str(raw), 0) + 1

    out: list[FilterFieldProfile] = []
    for key, count in present.items():
        bucket = values.get(key, {})
        distinct = len(bucket)
        top = [
            v
            for v, _n in sorted(bucket.items(), key=lambda kv: kv[1], reverse=True)
        ][:_MAX_DISTINCT_FOR_PICKER]
        out.append(
            FilterFieldProfile(
                field=key,
                present=count,
                sample_size=total,
                present_pct=round(100.0 * count / total, 1) if total else 0.0,
                values=top if distinct <= _MAX_DISTINCT_FOR_PICKER else [],
                distinct_count=distinct,
                type=types.get(key, "str"),
            )
        )
    out.sort(key=lambda f: (-f.present_pct, f.field))
    return out
