from datetime import datetime
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from app.assets import resolved_content_type
from pydantic import BaseModel
from sqlalchemy import select, func, desc, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import VerkadaCamera, VerkadaDoor, WebhookAsset, WebhookEvent


router = APIRouter(prefix="/api/webhook-events", tags=["webhook-events"])


class WebhookEventOut(BaseModel):
    id: UUID
    slug: str
    method: str
    path: str
    query_string: str
    headers: dict
    body_json: dict | list | None
    body_text: str | None
    body_size: int
    remote_addr: str | None
    received_at: datetime
    family: str | None
    webhook_type: str | None
    notification_type: str | None
    org_id: str | None
    signature_status: str | None

    model_config = {"from_attributes": True}


class WebhookEventListItem(BaseModel):
    id: UUID
    slug: str
    method: str
    path: str
    body_size: int
    remote_addr: str | None
    received_at: datetime
    family: str | None
    webhook_type: str | None
    notification_type: str | None
    signature_status: str | None

    model_config = {"from_attributes": True}


class WebhookEventList(BaseModel):
    items: list[WebhookEventListItem]
    total: int
    unknown_count: int


@router.get("", response_model=WebhookEventList)
async def list_events(
    q: str | None = Query(default=None, description="substring search across body, slug, notification_type, org_id"),
    family: str | None = Query(default=None),
    notification_type: str | None = Query(default=None),
    webhook_type: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> WebhookEventList:
    base = select(WebhookEvent)
    count_q = select(func.count()).select_from(WebhookEvent)
    if q:
        pattern = f"%{q}%"
        # If the query matches a camera or door *name* in our synced
        # cache, expand the search to also match webhooks whose body
        # contains the corresponding UUID. Without this, searching
        # "Playhouse" misses every event because the webhook body
        # carries camera_id = "9b8e0b89-…" — the friendly name only
        # lives in our local VerkadaCamera row.
        cam_ids = (
            await session.execute(
                select(VerkadaCamera.camera_id).where(
                    VerkadaCamera.name.ilike(pattern)
                )
            )
        ).scalars().all()
        door_ids = (
            await session.execute(
                select(VerkadaDoor.door_id).where(VerkadaDoor.name.ilike(pattern))
            )
        ).scalars().all()
        clauses = [
            WebhookEvent.body_text.ilike(pattern),
            WebhookEvent.slug.ilike(pattern),
            WebhookEvent.notification_type.ilike(pattern),
            WebhookEvent.org_id.ilike(pattern),
        ]
        for cid in cam_ids:
            clauses.append(WebhookEvent.body_text.ilike(f"%{cid}%"))
        for did in door_ids:
            clauses.append(WebhookEvent.body_text.ilike(f"%{did}%"))
        clause = or_(*clauses)
        base = base.where(clause)
        count_q = count_q.where(clause)
    if family is not None:
        base = base.where(WebhookEvent.family == family)
        count_q = count_q.where(WebhookEvent.family == family)
    if notification_type is not None:
        # Sentinel "__null__" filters to rows where notification_type is
        # actually NULL — used by the Stats page's "(unknown)" bucket so
        # users can drill into events Verkada didn't supply a type for.
        if notification_type == "__null__":
            base = base.where(WebhookEvent.notification_type.is_(None))
            count_q = count_q.where(WebhookEvent.notification_type.is_(None))
        else:
            base = base.where(WebhookEvent.notification_type == notification_type)
            count_q = count_q.where(WebhookEvent.notification_type == notification_type)
    if webhook_type is not None:
        base = base.where(WebhookEvent.webhook_type == webhook_type)
        count_q = count_q.where(WebhookEvent.webhook_type == webhook_type)

    base = base.order_by(WebhookEvent.received_at.desc()).limit(limit).offset(offset)
    rows = (await session.execute(base)).scalars().all()
    total = (await session.execute(count_q)).scalar_one()
    unknown = (
        await session.execute(
            select(func.count()).select_from(WebhookEvent).where(WebhookEvent.family == "unknown")
        )
    ).scalar_one()
    return WebhookEventList(
        items=[WebhookEventListItem.model_validate(r) for r in rows],
        total=total,
        unknown_count=unknown,
    )


class UnrecognizedGroup(BaseModel):
    webhook_type: str | None
    notification_type: str | None
    count: int
    last_seen: datetime
    sample_event_id: UUID


@router.get("/unrecognized", response_model=list[UnrecognizedGroup])
async def list_unrecognized(
    session: AsyncSession = Depends(get_session),
) -> list[UnrecognizedGroup]:
    """Group "unknown" events by (webhook_type, notification_type).

    This is the worklist for extending schemas.py — each row tells you a
    variant Verkada sends that we don't yet understand.
    """
    # Aggregates: count + last_seen per variant.
    agg = (
        select(
            WebhookEvent.webhook_type,
            WebhookEvent.notification_type,
            func.count().label("n"),
            func.max(WebhookEvent.received_at).label("last_seen"),
        )
        .where(WebhookEvent.family == "unknown")
        .group_by(WebhookEvent.webhook_type, WebhookEvent.notification_type)
        .order_by(desc("n"))
    )
    agg_rows = (await session.execute(agg)).all()
    if not agg_rows:
        return []

    # Latest sample id per variant — DISTINCT ON in PostgreSQL.
    samples = (
        select(
            WebhookEvent.webhook_type,
            WebhookEvent.notification_type,
            WebhookEvent.id,
        )
        .where(WebhookEvent.family == "unknown")
        .order_by(
            WebhookEvent.webhook_type,
            WebhookEvent.notification_type,
            WebhookEvent.received_at.desc(),
        )
        .distinct(WebhookEvent.webhook_type, WebhookEvent.notification_type)
    )
    sample_rows = (await session.execute(samples)).all()
    sample_map = {(s.webhook_type, s.notification_type): s.id for s in sample_rows}

    return [
        UnrecognizedGroup(
            webhook_type=r.webhook_type,
            notification_type=r.notification_type,
            count=r.n,
            last_seen=r.last_seen,
            sample_event_id=sample_map[(r.webhook_type, r.notification_type)],
        )
        for r in agg_rows
    ]


@router.delete("/unrecognized")
async def delete_all_unrecognized(
    session: AsyncSession = Depends(get_session),
) -> dict[str, int]:
    """Delete every event whose family is 'unknown'. Handy after fixing a smoke
    test's webhook shape or once you've added schemas for a new variant."""
    result = await session.execute(
        delete(WebhookEvent).where(WebhookEvent.family == "unknown")
    )
    await session.commit()
    return {"deleted": result.rowcount or 0}


@router.post("/reclassify")
async def reclassify_endpoint() -> dict[str, int]:
    """Re-classify all current 'unknown' rows against the latest schemas.

    Same operation that runs automatically on backend startup — exposed here
    for manual re-runs without restarting the container.
    """
    from app.reclassify import reclassify_unknowns as _run

    return await _run()


class WebhookAssetOut(BaseModel):
    id: UUID
    source_field: str
    source_url: str
    content_type: str | None
    file_size: int | None
    status: str
    error: str | None
    created_at: datetime
    expires_at: datetime


@router.get("/{event_id}/assets", response_model=list[WebhookAssetOut])
async def list_event_assets(
    event_id: UUID, session: AsyncSession = Depends(get_session)
) -> list[WebhookAssetOut]:
    rows = (
        await session.execute(
            select(WebhookAsset)
            .where(WebhookAsset.webhook_event_id == event_id)
            .order_by(WebhookAsset.created_at)
        )
    ).scalars().all()
    return [
        WebhookAssetOut(
            id=a.id,
            source_field=a.source_field,
            source_url=a.source_url,
            content_type=resolved_content_type(
                a.content_type, Path(a.local_path) if a.local_path else None
            ),
            file_size=a.file_size,
            status=a.status,
            error=a.error,
            created_at=a.created_at,
            expires_at=a.expires_at,
        )
        for a in rows
    ]


@router.get("/assets/{asset_id}/file")
async def stream_asset_file(
    asset_id: UUID, session: AsyncSession = Depends(get_session)
):
    asset = await session.get(WebhookAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    if asset.status != "ready" or not asset.local_path:
        raise HTTPException(
            status_code=404, detail=f"asset not ready (status={asset.status})"
        )
    path = Path(asset.local_path)
    if not path.is_file():
        raise HTTPException(status_code=410, detail="asset file missing on disk")
    return FileResponse(
        path,
        media_type=resolved_content_type(asset.content_type, path),
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/{event_id}", response_model=WebhookEventOut)
async def get_event(
    event_id: UUID, session: AsyncSession = Depends(get_session)
) -> WebhookEventOut:
    row = await session.get(WebhookEvent, event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    return WebhookEventOut.model_validate(row)


@router.delete("/{event_id}")
async def delete_event(
    event_id: UUID, session: AsyncSession = Depends(get_session)
) -> dict:
    row = await session.get(WebhookEvent, event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    await session.delete(row)
    await session.commit()
    return {"ok": True}
