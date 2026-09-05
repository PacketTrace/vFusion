"""Requesting a video, waiting for it, keeping it.

Generation takes minutes, so nothing here is request-scoped: a job is
recorded, a worker thread drives it, and the browser polls. The job
record is the only durable thing — it survives the page being closed,
which is the whole point of writing it down.

Restarts are the honest gap. The Veo operation continues on Google's
side, but the polling loop does not survive a container restart, so
anything left running is marked interrupted at boot rather than left
claiming to be in progress forever. A job that says it is running and
is not is the failure mode worth avoiding; a job that says it was
interrupted can simply be asked again.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.video.prompt import VideoRequest, describe


logger = logging.getLogger(__name__)

STORE_PATH = Path(os.environ.get("VIDEO_JOBS_FILE", "/app/data/generated_video/jobs.json"))
CLIP_DIR = Path(os.environ.get("VIDEO_CLIP_DIR", "/app/data/generated_video"))

MAX_JOBS = 60

_lock = asyncio.Lock()
# Tasks are held so the event loop cannot collect them mid-flight —
# asyncio keeps only a weak reference to a bare create_task.
_running: dict[str, asyncio.Task[None]] = {}


async def load() -> list[dict[str, Any]]:
    try:
        async with _lock:
            raw = STORE_PATH.read_text(encoding="utf-8")
    except OSError:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return data if isinstance(data, list) else []


async def _write(jobs: list[dict[str, Any]]) -> None:
    try:
        async with _lock:
            STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = STORE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(jobs[:MAX_JOBS], separators=(",", ":")), encoding="utf-8")
            tmp.replace(STORE_PATH)
    except OSError:
        logger.warning("could not persist video jobs", exc_info=True)


async def _update(job_id: str, **fields: Any) -> None:
    jobs = await load()
    for job in jobs:
        if job.get("id") == job_id:
            job.update(fields)
            break
    await _write(jobs)


async def mark_interrupted_on_boot() -> int:
    """Anything still 'running' from a previous process cannot be."""
    jobs = await load()
    n = 0
    for job in jobs:
        if job.get("status") in ("queued", "running"):
            job["status"] = "interrupted"
            job["error"] = (
                "The backend restarted while this was generating. Google may "
                "have finished it, but vFusion stopped watching — ask again."
            )
            n += 1
    if n:
        await _write(jobs)
    return n


def _generate_blocking(api_key: str, req: VideoRequest, prompt: str, out: Path) -> dict[str, Any]:
    """The SDK call, start to finished file. Runs in a worker thread."""
    import time

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    operation = client.models.generate_videos(
        model=req.model,
        prompt=prompt,
        config=types.GenerateVideosConfig(
            aspect_ratio=req.aspect_ratio,
            resolution=req.resolution,
            duration_seconds=str(req.duration_seconds),
        ),
    )
    waited = 0
    # Generous, because generation genuinely takes minutes — but bounded,
    # because a job that waits forever is indistinguishable from one that
    # is stuck.
    while not operation.done and waited < 900:
        time.sleep(10)
        waited += 10
        operation = client.operations.get(operation)
    if not operation.done:
        raise TimeoutError("gave up waiting after 15 minutes")

    videos = getattr(operation.response, "generated_videos", None) or []
    if not videos:
        raise RuntimeError(
            "generation finished but returned no video — usually a prompt "
            "the safety filters declined"
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    client.files.download(file=videos[0].video, destination=str(out))
    return {"waited_sec": waited, "bytes": out.stat().st_size if out.exists() else 0}


async def _run(job_id: str, api_key: str, req: VideoRequest, prompt: str) -> None:
    out = CLIP_DIR / f"{job_id}.mp4"
    await _update(job_id, status="running", started_at=datetime.now(timezone.utc).isoformat())
    try:
        result = await asyncio.to_thread(_generate_blocking, api_key, req, prompt, out)
    except Exception as e:  # noqa: BLE001 — every failure belongs on the job
        logger.warning("video job %s failed: %s", job_id, e)
        await _update(
            job_id,
            status="failed",
            error=str(e)[:500],
            finished_at=datetime.now(timezone.utc).isoformat(),
        )
        return
    finally:
        _running.pop(job_id, None)
    await _update(
        job_id,
        status="done",
        finished_at=datetime.now(timezone.utc).isoformat(),
        bytes=result.get("bytes", 0),
        waited_sec=result.get("waited_sec", 0),
    )


async def submit(api_key: str, req: VideoRequest) -> dict[str, Any]:
    """Record the job and start it. Returns the job immediately."""
    job_id = str(uuid.uuid4())
    prompt = describe(req)
    job = {
        "id": job_id,
        "at": datetime.now(timezone.utc).isoformat(),
        "status": "queued",
        "scene": req.scene,
        "setting": req.setting,
        "vantage": req.vantage,
        "lighting": req.lighting,
        "activity": req.activity,
        "framing": req.framing,
        "focus_target": req.focus_target,
        "duration_seconds": req.duration_seconds,
        "resolution": req.resolution,
        "model": req.model,
        # Kept so a clip that came out wrong can be read back against
        # what was actually asked for, rather than what was intended.
        "prompt": prompt,
        "error": None,
    }
    jobs = await load()
    await _write([job, *jobs])
    task = asyncio.create_task(_run(job_id, api_key, req, prompt))
    _running[job_id] = task
    return job


async def remove(job_id: str) -> bool:
    jobs = await load()
    kept = [j for j in jobs if j.get("id") != job_id]
    if len(kept) == len(jobs):
        return False
    await _write(kept)
    path = CLIP_DIR / f"{job_id}.mp4"
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("could not delete %s", path)
    return True


def clip_path(job_id: str) -> Path:
    return CLIP_DIR / f"{job_id}.mp4"
