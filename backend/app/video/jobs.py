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


def _save_video(client: Any, video: Any, out: Path) -> int:
    """Get the bytes onto disk, whichever way this SDK version offers.

    The published example passes ``destination=`` to files.download; the
    installed SDK has no such argument and returns bytes instead. That
    mismatch threw away a clip that had already been generated and paid
    for, which is the expensive kind of wrong. So all three routes are
    tried rather than trusting any one signature: download-to-bytes,
    the video_bytes the download sets as a side effect, and Video.save.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    try:
        data = client.files.download(file=video)
        if isinstance(data, (bytes, bytearray)) and data:
            out.write_bytes(data)
            return len(data)
    except Exception as e:  # noqa: BLE001
        errors.append(f"download: {e}")

    # download() sets this on the object as a documented side effect,
    # so it may be populated even when the call above returned nothing.
    data = getattr(video, "video_bytes", None)
    if isinstance(data, (bytes, bytearray)) and data:
        out.write_bytes(data)
        return len(data)

    try:
        video.save(str(out))
        if out.is_file() and out.stat().st_size > 0:
            return out.stat().st_size
    except Exception as e:  # noqa: BLE001
        errors.append(f"save: {e}")

    raise RuntimeError(
        "the video generated but could not be saved — " + "; ".join(errors)
    )


def _generate_blocking(
    api_key: str, req: VideoRequest, prompt: str, out: Path, on_generated: Any = None
) -> dict[str, Any]:
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
    video = videos[0].video
    # Recorded before the save is attempted. Generation is the part that
    # costs money, so if saving fails the job should still say what was
    # produced rather than looking like nothing happened.
    if on_generated is not None:
        on_generated(getattr(video, "uri", None))
    size = _save_video(client, video, out)
    return {"waited_sec": waited, "bytes": size}


async def _run(job_id: str, api_key: str, req: VideoRequest, prompt: str) -> None:
    out = CLIP_DIR / f"{job_id}.mp4"
    await _update(job_id, status="running", started_at=datetime.now(timezone.utc).isoformat())
    loop = asyncio.get_running_loop()

    def note_generated(uri: str | None) -> None:
        # Called from the worker thread the moment generation completes,
        # so the uri is on the job even if the save then fails.
        asyncio.run_coroutine_threadsafe(
            _update(job_id, video_uri=uri, status="saving"), loop
        )

    try:
        result = await asyncio.to_thread(
            _generate_blocking, api_key, req, prompt, out, note_generated
        )
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
