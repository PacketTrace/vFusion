"""Pull a video from a URL into the queue.

Downloading rather than streaming. A hosted video's direct URL is signed
and expires, so a stream that resolved it once would fail somewhere in
the middle of the third replay with a 403 that looks like a network
problem. A file on disk plays the same way on the hundredth loop as the
first, and the queue already knows what to do with files.

yt-dlp does the fetching for everything, not just the sites it is known
for -- its generic extractor handles a plain ``.mp4`` or an ``.m3u8`` as
well, so there is one path here rather than a special case per kind of
URL.

Video only, no audio track. The pump discards audio anyway (``-an`` on
every source), and asking for video alone skips the merge step, halves
the transfer, and removes ffmpeg from the download entirely.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.rtsp import queue, settings


logger = logging.getLogger(__name__)

# Matches the upload limit. A cap also stops a mistyped URL pointing at
# something enormous from filling the volume unattended.
MAX_BYTES = 512 * 1024 * 1024

# Long enough for a feature-length download on a slow line, short enough
# that a stalled fetch does not sit there forever looking busy.
TIMEOUT_SEC = 1800

# In-flight and recently finished fetches, so the page can show that
# something is happening. A download takes minutes and an endpoint that
# returned nothing for that long would read as broken.
jobs: dict[str, dict[str, Any]] = {}


def _fmt() -> str:
    """Prefer H.264 at or below the stream's own height.

    Downloading 4K to scale it to 1080 costs bandwidth and decode time
    for detail that is discarded on the way through. Falling back to
    "best" keeps a source with no matching format usable rather than
    failing outright.
    """
    h = settings.HEIGHT
    return (
        f"bv*[height<={h}][vcodec^=avc1]/bv*[height<={h}]/"
        f"b[height<={h}]/bv*/b"
    )


def recent() -> list[dict[str, Any]]:
    return sorted(jobs.values(), key=lambda j: j["at"], reverse=True)[:10]


async def start(url: str) -> dict[str, Any]:
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "url": url,
        "title": "",
        "state": "fetching",
        "error": "",
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    jobs[job_id] = job
    # Trim rather than grow without bound; ten is what the page shows.
    for stale in sorted(jobs.values(), key=lambda j: j["at"])[:-25]:
        jobs.pop(stale["id"], None)
    asyncio.create_task(_run(job))
    return job


async def _run(job: dict[str, Any]) -> None:
    job_id = job["id"]
    target = queue.MEDIA_DIR / job_id
    try:
        queue.MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp",
            "--no-playlist",
            "--no-progress",
            "--no-warnings",
            "--write-info-json",
            "--max-filesize", str(MAX_BYTES),
            "-f", _fmt(),
            "-o", f"{target}.%(ext)s",
            job["url"],
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_SEC)
        if proc.returncode != 0:
            raise RuntimeError(_explain(err.decode("utf-8", "replace")))

        info = target.with_suffix(".info.json")
        title = job["url"]
        if info.is_file():
            try:
                title = json.loads(info.read_text()).get("title") or title
            except (OSError, ValueError):
                pass
            info.unlink(missing_ok=True)

        media = next(
            (
                p
                for p in queue.MEDIA_DIR.glob(f"{job_id}.*")
                if p.suffix.lower() in queue.VIDEO_SUFFIXES
            ),
            None,
        )
        if media is None:
            raise RuntimeError("nothing downloadable at that URL")

        job["title"] = title
        # Handed to the queue by path rather than by re-reading the bytes:
        # a 500 MB file does not need to exist twice, once on disk and
        # once in memory, to be added to a list.
        await queue.adopt(media, f"{title}{media.suffix}")
        job["state"] = "done"
    except asyncio.TimeoutError:
        job["state"] = "failed"
        job["error"] = f"gave up after {TIMEOUT_SEC // 60} minutes"
    except Exception as e:  # noqa: BLE001 — a failed fetch is a UI state
        job["state"] = "failed"
        job["error"] = str(e)
        logger.warning("url fetch failed (%s): %s", job["url"], e)
    finally:
        if job["state"] == "failed":
            for leftover in queue.MEDIA_DIR.glob(f"{job_id}.*"):
                leftover.unlink(missing_ok=True)


def _explain(stderr: str) -> str:
    """yt-dlp's last line, which is the one that says what went wrong.

    Its stderr is mostly extractor chatter and the useful sentence is at
    the end. Passing the whole thing to the UI buries it.
    """
    lines = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    if not lines:
        return "download failed"
    last = lines[-1]
    if "File is larger than max-filesize" in stderr:
        return f"larger than the {MAX_BYTES // (1024 * 1024)} MB limit"
    return last.removeprefix("ERROR: ").strip() or "download failed"
