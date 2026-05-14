"""API for the Verkada OpenAPI catalog."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.catalog import crawl_all
from app.db import get_session
from app.models import VerkadaApiEndpoint, VerkadaApiSpec


router = APIRouter(prefix="/api/verkada/catalog", tags=["verkada-catalog"])


class SpecOut(BaseModel):
    id: str
    namespace: str
    url: str
    title: str | None
    api_version: str | None
    openapi_version: str | None
    fetch_status: str
    fetch_error: str | None
    last_fetched_at: datetime | None
    last_changed_at: datetime | None
    endpoint_count: int


class EndpointListItem(BaseModel):
    id: str
    namespace: str
    method: str
    path: str
    operation_id: str | None
    summary: str | None
    tags: list[str] | None
    docs_url: str | None
    first_seen_at: datetime
    last_seen_at: datetime
    last_changed_at: datetime
    deleted_at: datetime | None


class EndpointDetail(EndpointListItem):
    description: str | None
    raw: Any


def _docs_url(operation_id: str | None) -> str | None:
    """Verkada's docs site (ReadMe.io) lowercases the operation_id and uses
    it as the slug under /reference. E.g. getVideoTaggingEventTypeViewV1 →
    apidocs.verkada.com/reference/getvideotaggingeventtypeviewv1."""
    if not operation_id:
        return None
    return f"https://apidocs.verkada.com/reference/{operation_id.lower()}"


def _resolve_refs(
    node: Any,
    root: dict[str, Any],
    depth: int = 0,
    max_depth: int = 8,
    seen: tuple[str, ...] = (),
) -> Any:
    """Walk an OpenAPI sub-tree and inline ``$ref`` references against
    ``root`` (the full spec doc). Bounded by ``max_depth`` so a cyclic
    schema can't spin forever, and tracks the chain of refs already
    expanded to avoid the same self-referential type being inlined
    infinitely deep. The frontend renders the resolved version directly
    — much simpler than threading a resolver through every component."""
    if depth > max_depth:
        return node
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            if ref in seen:
                # Already on the resolution stack — stop here and surface
                # the ref name so the UI can show "<recursive: Foo>".
                return {"$ref": ref, "_recursive": True}
            parts = ref[2:].split("/")
            target: Any = root
            for p in parts:
                if not isinstance(target, dict) or p not in target:
                    return node
                target = target[p]
            return _resolve_refs(
                target, root, depth + 1, max_depth, seen + (ref,)
            )
        return {
            k: _resolve_refs(v, root, depth + 1, max_depth, seen)
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [_resolve_refs(v, root, depth + 1, max_depth, seen) for v in node]
    return node


class EndpointList(BaseModel):
    items: list[EndpointListItem]
    total: int


@router.get("/specs", response_model=list[SpecOut])
async def list_specs(session: AsyncSession = Depends(get_session)) -> list[SpecOut]:
    counts = dict(
        (await session.execute(
            select(VerkadaApiEndpoint.spec_id, func.count())
            .where(VerkadaApiEndpoint.deleted_at.is_(None))
            .group_by(VerkadaApiEndpoint.spec_id)
        )).all()
    )
    specs = (
        await session.execute(select(VerkadaApiSpec).order_by(VerkadaApiSpec.namespace))
    ).scalars().all()
    return [
        SpecOut(
            id=str(s.id),
            namespace=s.namespace,
            url=s.url,
            title=s.title,
            api_version=s.api_version,
            openapi_version=s.openapi_version,
            fetch_status=s.fetch_status,
            fetch_error=s.fetch_error,
            last_fetched_at=s.last_fetched_at,
            last_changed_at=s.last_changed_at,
            endpoint_count=counts.get(s.id, 0),
        )
        for s in specs
    ]


@router.get("/endpoints", response_model=EndpointList)
async def list_endpoints(
    namespace: str | None = Query(default=None),
    q: str | None = Query(default=None, description="substring across path, summary, operation_id"),
    include_deleted: bool = Query(default=False),
    changed_since_days: int | None = Query(default=None, ge=1, le=365),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> EndpointList:
    base = select(VerkadaApiEndpoint)
    count_q = select(func.count()).select_from(VerkadaApiEndpoint)

    if not include_deleted:
        base = base.where(VerkadaApiEndpoint.deleted_at.is_(None))
        count_q = count_q.where(VerkadaApiEndpoint.deleted_at.is_(None))
    if namespace:
        base = base.where(VerkadaApiEndpoint.namespace == namespace)
        count_q = count_q.where(VerkadaApiEndpoint.namespace == namespace)
    if q:
        pattern = f"%{q}%"
        clause = or_(
            VerkadaApiEndpoint.path.ilike(pattern),
            VerkadaApiEndpoint.summary.ilike(pattern),
            VerkadaApiEndpoint.operation_id.ilike(pattern),
        )
        base = base.where(clause)
        count_q = count_q.where(clause)
    if changed_since_days is not None:
        cutoff = func.now() - func.make_interval(0, 0, 0, changed_since_days)
        base = base.where(VerkadaApiEndpoint.last_changed_at >= cutoff)
        count_q = count_q.where(VerkadaApiEndpoint.last_changed_at >= cutoff)

    base = (
        base.order_by(VerkadaApiEndpoint.last_changed_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = (await session.execute(base)).scalars().all()
    total = (await session.execute(count_q)).scalar_one()
    return EndpointList(
        items=[
            EndpointListItem(
                id=str(r.id),
                namespace=r.namespace,
                method=r.method,
                path=r.path,
                operation_id=r.operation_id,
                summary=r.summary,
                tags=r.tags,
                docs_url=_docs_url(r.operation_id),
                first_seen_at=r.first_seen_at,
                last_seen_at=r.last_seen_at,
                last_changed_at=r.last_changed_at,
                deleted_at=r.deleted_at,
            )
            for r in rows
        ],
        total=total,
    )


@router.get("/endpoints/{endpoint_id}", response_model=EndpointDetail)
async def get_endpoint(
    endpoint_id: str, session: AsyncSession = Depends(get_session)
) -> EndpointDetail:
    from uuid import UUID

    from fastapi import HTTPException

    try:
        eid = UUID(endpoint_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="bad id")
    row = await session.get(VerkadaApiEndpoint, eid)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    # Inline any $ref schemas against the parent spec so the frontend can
    # render parameters / request body / responses without needing its own
    # resolver. Falls back to raw on failure — never block detail load
    # over a malformed spec.
    raw = row.raw or {}
    spec = await session.get(VerkadaApiSpec, row.spec_id)
    try:
        if spec and isinstance(spec.raw, dict):
            raw = _resolve_refs(row.raw or {}, spec.raw)
    except Exception:  # noqa: BLE001
        raw = row.raw
    return EndpointDetail(
        id=str(row.id),
        namespace=row.namespace,
        method=row.method,
        path=row.path,
        operation_id=row.operation_id,
        summary=row.summary,
        description=row.description,
        tags=row.tags,
        docs_url=_docs_url(row.operation_id),
        first_seen_at=row.first_seen_at,
        last_seen_at=row.last_seen_at,
        last_changed_at=row.last_changed_at,
        deleted_at=row.deleted_at,
        raw=raw,
    )


@router.post("/crawl")
async def trigger_crawl() -> list[dict[str, Any]]:
    """Run the catalog crawl right now — same operation the 4-hour cron does."""
    return await crawl_all()
