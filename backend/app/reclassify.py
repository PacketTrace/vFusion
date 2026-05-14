"""Re-run classification on existing rows.

Triggered automatically on backend startup and exposed as an endpoint for
manual re-runs. Whenever we add a new ``notification_type`` to
``schemas.py``, rows that were previously stored as ``family='unknown'``
get re-evaluated against the latest taxonomy and flipped to the right
family in place — no manual cleanup needed.

Cheap operation: filtered by the indexed ``family`` column, scans only the
unknown rows, and commits in one transaction.
"""

import logging

from pydantic import ValidationError
from sqlalchemy import select

from app.connectors.verkada import Envelope, classify
from app.db import SessionLocal
from app.models import WebhookEvent


logger = logging.getLogger(__name__)


async def reclassify_unknowns() -> dict[str, int]:
    """Re-classify all webhook_events currently marked unknown.

    Returns counts: how many were scanned and how many flipped to a known
    family. Safe to call repeatedly; rows that still don't match anything
    stay marked unknown.
    """
    flipped = 0
    scanned = 0
    async with SessionLocal() as session:
        result = await session.execute(
            select(WebhookEvent).where(WebhookEvent.family == "unknown")
        )
        rows = result.scalars().all()
        for row in rows:
            scanned += 1
            if not isinstance(row.body_json, dict):
                continue
            try:
                env = Envelope.model_validate(row.body_json)
            except ValidationError:
                continue
            new_family = classify(env)
            if new_family == "unknown":
                continue
            row.family = new_family
            row.webhook_type = env.webhook_type
            nt = env.data.get("notification_type") if isinstance(env.data, dict) else None
            if isinstance(nt, str):
                row.notification_type = nt
            flipped += 1
        if flipped > 0:
            await session.commit()
    if scanned:
        logger.info(
            "reclassify: scanned=%d flipped=%d still_unknown=%d",
            scanned,
            flipped,
            scanned - flipped,
        )
    return {"scanned": scanned, "flipped": flipped}
