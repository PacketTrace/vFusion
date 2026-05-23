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
