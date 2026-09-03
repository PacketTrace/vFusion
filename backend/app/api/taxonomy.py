from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada import TAXONOMY
from app.db import get_session
from app.models import WebhookEvent


router = APIRouter(prefix="/api/taxonomy", tags=["taxonomy"])


@router.get("/verkada")
async def verkada_taxonomy() -> dict:
    """Family → {label, webhook_type, notification_types, filter_fields}.

    The frontend uses this to render the trigger node's family/event-type
    picker without hardcoding strings.
    """
    return TAXONOMY


@router.get("/coverage")
async def taxonomy_coverage(
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Which event types we have a real sample of, and which we do not.

    The filter picker is built entirely from observed payloads, so a type
    nobody has ever sent is a type we cannot offer sensible filters for —
    it will show ``camera_id`` and nothing else. This turns that blind
    spot into a list: the types still worth capturing an example of.
    """
    rows = (
        await session.execute(
            select(
                WebhookEvent.notification_type,
                func.count().label("n"),
                func.max(WebhookEvent.received_at).label("last_seen"),
            )
            .where(WebhookEvent.notification_type.is_not(None))
            .group_by(WebhookEvent.notification_type)
        )
    ).all()
    counts = {r.notification_type: (r.n, r.last_seen) for r in rows}

    families = []
    for key, family in TAXONOMY.items():
        types = []
        for nt in family.get("notification_types", []):
            n, last_seen = counts.get(nt, (0, None))
            meta = family.get("notification_type_meta", {}).get(nt, {})
            types.append(
                {
                    "notification_type": nt,
                    "label": meta.get("label") or nt,
                    "count": n,
                    "last_seen": last_seen.isoformat() if last_seen else None,
                }
            )
        types.sort(key=lambda t: (t["count"], t["notification_type"]))
        families.append(
            {
                "family": key,
                "label": family.get("label", key),
                "types": types,
                "seen": sum(1 for t in types if t["count"]),
                "total": len(types),
            }
        )

    return {
        "families": families,
        "seen": sum(f["seen"] for f in families),
        "total": sum(f["total"] for f in families),
    }
