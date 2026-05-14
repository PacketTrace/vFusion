from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.footage import CLIP_ROOT, IMAGE_ROOT
from app.db import get_session
from app.models import Flow, Run, RunEvent


router = APIRouter(prefix="/api/runs", tags=["runs"])


class RunListItem(BaseModel):
    id: UUID
    flow_id: UUID | None
    flow_name: str | None
    webhook_event_id: UUID | None
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class RunDetail(BaseModel):
    id: UUID
    flow_id: UUID | None
    flow_name: str | None
    webhook_event_id: UUID | None
    status: str
    input: Any | None
    output: Any | None
    error: str | None
    steps: list[dict[str, Any]] = []
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class RunList(BaseModel):
    items: list[RunListItem]
    total: int


@router.get("", response_model=RunList)
async def list_runs(
    flow_id: UUID | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> RunList:
    base = select(Run, Flow.name).join(Flow, Flow.id == Run.flow_id, isouter=True)
    count_q = select(func.count()).select_from(Run)
    if flow_id is not None:
        base = base.where(Run.flow_id == flow_id)
        count_q = count_q.where(Run.flow_id == flow_id)
    if status is not None:
        base = base.where(Run.status == status)
        count_q = count_q.where(Run.status == status)
    base = base.order_by(Run.created_at.desc()).limit(limit).offset(offset)
    rows = (await session.execute(base)).all()
    total = (await session.execute(count_q)).scalar_one()
    items = [
        RunListItem(
            id=r.Run.id,
            flow_id=r.Run.flow_id,
            flow_name=_display_flow_name(r.name, r.Run.input),
            webhook_event_id=r.Run.webhook_event_id,
            status=r.Run.status,
            started_at=r.Run.started_at,
            finished_at=r.Run.finished_at,
            created_at=r.Run.created_at,
        )
        for r in rows
    ]
    return RunList(items=items, total=total)


def _display_flow_name(joined_name: str | None, input_: Any) -> str | None:
    """If the row still has a real flow name, prefer it. Otherwise label
    Workbench one-offs explicitly so the UI doesn't fall back to
    "(deleted flow)". The persisted input.byoa flag stays so we don't
    have to migrate every historical row to a new name."""
    if joined_name:
        return joined_name
    if isinstance(input_, dict) and input_.get("byoa"):
        return "Workbench"
    return None


@router.get("/{run_id}", response_model=RunDetail)
async def get_run(
    run_id: UUID, session: AsyncSession = Depends(get_session)
) -> RunDetail:
    row = (
        await session.execute(
            select(Run, Flow.name)
            .join(Flow, Flow.id == Run.flow_id, isouter=True)
            .where(Run.id == run_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    return RunDetail(
        id=row.Run.id,
        flow_id=row.Run.flow_id,
        flow_name=_display_flow_name(row.name, row.Run.input),
        webhook_event_id=row.Run.webhook_event_id,
        status=row.Run.status,
        input=row.Run.input,
        output=row.Run.output,
        error=row.Run.error,
        steps=row.Run.steps or [],
        started_at=row.Run.started_at,
        finished_at=row.Run.finished_at,
        created_at=row.Run.created_at,
    )


class RunEventOut(BaseModel):
    id: UUID
    step_name: str | None
    phase: str | None
    status: str | None
    message: str | None
    ts: datetime

    model_config = {"from_attributes": True}


@router.get("/{run_id}/events", response_model=list[RunEventOut])
async def list_run_events(
    run_id: UUID,
    since: datetime | None = Query(default=None, description="Only return events newer than this timestamp."),
    session: AsyncSession = Depends(get_session),
) -> list[RunEventOut]:
    q = select(RunEvent).where(RunEvent.run_id == run_id)
    if since is not None:
        q = q.where(RunEvent.ts > since)
    q = q.order_by(RunEvent.ts.asc())
    rows = (await session.execute(q)).scalars().all()
    return [RunEventOut.model_validate(r) for r in rows]


def _serve_step_file(
    run: Run,
    step_name: str,
    output_field: str,
    allowed_root: Path,
    media_type: str,
):
    target_step = next(
        (s for s in (run.steps or []) if s.get("name") == step_name), None
    )
    if target_step is None:
        raise HTTPException(status_code=404, detail=f"step {step_name!r} not found in run")
    output = target_step.get("output") or {}
    raw = output.get(output_field) if isinstance(output, dict) else None
    if not isinstance(raw, str) or not raw:
        raise HTTPException(
            status_code=404, detail=f"step has no {output_field} output"
        )
    root = allowed_root.resolve()
    path = Path(raw).resolve()
    try:
        path.relative_to(root)
    except ValueError as e:
        raise HTTPException(
            status_code=400, detail=f"path is outside {allowed_root}"
        ) from e
    if not path.is_file():
        raise HTTPException(status_code=410, detail="file no longer on disk")
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/{run_id}/clip")
async def serve_run_clip(
    run_id: UUID,
    step: str = Query(..., description="Step name whose output.clip_path to serve"),
    session: AsyncSession = Depends(get_session),
):
    """Serve an MP4 produced by a gemini_analyze_camera step. The path is
    looked up from the run's recorded step output, and we refuse anything
    that resolves outside CLIP_ROOT — never trust the stored string."""
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    return _serve_step_file(run, step, "clip_path", CLIP_ROOT, "video/mp4")


@router.get("/{run_id}/image")
async def serve_run_image(
    run_id: UUID,
    step: str = Query(..., description="Step name whose output.image_path to serve"),
    session: AsyncSession = Depends(get_session),
):
    """Serve a JPEG produced by a gemini_analyze_still_image step."""
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    return _serve_step_file(run, step, "image_path", IMAGE_ROOT, "image/jpeg")
