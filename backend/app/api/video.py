"""Request a generated clip, watch it come back, keep it."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto import decrypt_secret
from app.db import get_session
from app.models import Connection
from app.video import jobs as video_jobs
from app.video import prompt as video_prompt


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/video", tags=["video"])


class GenerateRequest(BaseModel):
    scene: str
    setting: str = "retail_checkout"
    vantage: str = "ceiling_dome"
    lighting: str = "daylight_indoor"
    activity: str = "one_person"
    framing: str = "general"
    focus_target: str = ""
    duration_seconds: int = 8
    resolution: str = "720p"
    model: str = "veo-3.1-generate-preview"
    extra: str = ""


@router.get("/options")
async def options() -> dict[str, Any]:
    """The vocabulary the form is built from, straight from the module
    that shapes the prompt — so a new vantage appears in the UI without
    anyone updating a second list."""
    return {
        "vantages": video_prompt.VANTAGES,
        "settings": video_prompt.SETTINGS,
        "lighting": video_prompt.LIGHTING,
        "activity": video_prompt.ACTIVITY,
        "price_per_second": video_prompt.PRICE_PER_SECOND,
    }


@router.post("/preview-prompt")
async def preview_prompt(body: GenerateRequest) -> dict[str, str]:
    """What would be sent, without sending it.

    Worth having its own endpoint: generation costs real money and takes
    minutes, and reading the prompt first is how you find out the camera
    is pointed at the wrong thing for free.
    """
    return {"prompt": video_prompt.describe(video_prompt.VideoRequest(**body.model_dump()))}


@router.post("/generate")
async def generate(
    body: GenerateRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    if not body.scene.strip():
        raise HTTPException(status_code=400, detail="Describe what happens in the clip.")
    conn = (
        await session.execute(
            select(Connection)
            .where(Connection.type == "gemini")
            .order_by(Connection.created_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if conn is None:
        raise HTTPException(
            status_code=400,
            detail="Video generation uses the same Gemini key as the rest of vFusion — add one on Connections.",
        )
    api_key = (decrypt_secret(conn.encrypted_secret) or {}).get("api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="That Gemini connection has no API key.")

    return await video_jobs.submit(
        api_key, video_prompt.VideoRequest(**body.model_dump())
    )


@router.get("/jobs")
async def list_jobs() -> list[dict[str, Any]]:
    return await video_jobs.load()


@router.get("/file/{job_id}")
async def get_clip(job_id: str) -> FileResponse:
    path = video_jobs.clip_path(job_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No clip for that job.")
    return FileResponse(path, media_type="video/mp4", filename=f"{job_id}.mp4")


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str) -> dict[str, bool]:
    return {"removed": await video_jobs.remove(job_id)}


@router.post("/jobs/{job_id}/use")
async def use_in_camera(job_id: str) -> dict[str, Any]:
    """Put a generated clip into the virtual camera's queue.

    The pump plays items from its own queue, and a generated clip is a
    file sitting somewhere else. ``adopt`` registers it in place rather
    than copying — the sequencer then has an item id it can jump the
    queue with.
    """
    from app.rtsp import queue as rtsp_queue

    path = video_jobs.clip_path(job_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No clip for that job.")
    jobs = await video_jobs.load()
    job = next((j for j in jobs if j.get("id") == job_id), None)
    name = (job or {}).get("scene") or "Generated clip"
    for existing in rtsp_queue.list_all():
        if existing.get("id") == path.stem:
            return existing
    return await rtsp_queue.adopt(path, f"{name[:60]}.mp4")


# Same ceiling as the virtual camera's own upload — a demo clip that
# will not fit through that path is no use here either.
MAX_UPLOAD_BYTES = 512 * 1024 * 1024
VIDEO_SUFFIXES = (".mp4", ".mov", ".mkv", ".webm", ".ts")


@router.post("/upload")
async def upload(file: UploadFile = File(...)) -> dict[str, Any]:
    """Add your own footage to the library.

    Generated and uploaded clips are the same thing once they exist —
    a file that can be played on the virtual camera and pointed at by a
    Helix event — so an upload becomes a job record like any other,
    already done, with no prompt because nobody wrote one.
    """
    name = file.filename or "upload.mp4"
    if not name.lower().endswith(VIDEO_SUFFIXES):
        raise HTTPException(
            status_code=400,
            detail=f"Video files only: {', '.join(VIDEO_SUFFIXES)}.",
        )
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="That file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
        )
    return await video_jobs.record_upload(name, data)
