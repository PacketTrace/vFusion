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


@router.get("/sample-fields", response_model=list[TriggerField])
async def sample_fields(
    family: str | None = Query(default=None),
    notification_type: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[TriggerField]:
    q = select(WebhookEvent).where(WebhookEvent.body_json.is_not(None))
    if family:
        q = q.where(WebhookEvent.family == family)
    if notification_type:
        q = q.where(WebhookEvent.notification_type == notification_type)
    q = q.order_by(desc(WebhookEvent.received_at)).limit(1)
    row = (await session.execute(q)).scalar_one_or_none()
    if row is None or not isinstance(row.body_json, dict):
        return []
    out: list[TriggerField] = []
    _flatten(row.body_json, "trigger", out)
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
