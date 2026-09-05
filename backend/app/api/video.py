"""Request a generated clip, watch it come back, keep it."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
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
