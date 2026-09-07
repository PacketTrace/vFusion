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
import pathlib
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
    """H.264 at or below the stream's own height, with its audio.

    Video-only was right when the pump discarded audio; it does not any
    more, so a video fetched without a track would play as silence and
    look like a bug in the audio path rather than a decision made during
    the download.

    Height is still capped: fetching 4K to scale it to 1080 spends
    bandwidth and decode time on detail discarded on the way through.
    Falling back to "best" keeps a source with no matching format usable
    rather than failing outright.
    """
    h = settings.HEIGHT
    cap = MAX_BYTES
    # Size is part of the selection, not a limit applied afterwards.
    #
    # --max-filesize aborts a download that turns out too big; it does
    # not make yt-dlp choose differently. On a two-hour source that
    # meant the video stream aborted, the small audio stream succeeded,
    # and what landed on disk was an audio-only file — a real "no video
    # track", for a reason that had nothing to do with the URL.
    #
    # Asking for a format under the cap lets it step down through
    # heights instead, which is what somebody pointing at a long video
    # actually wants: a smaller copy, not a failure.
    ladder = [h, 720, 480, 360]
    tries = []
    for height in ladder:
        tries.append(f"bv*[height<={height}][vcodec^=avc1][filesize_approx<{cap}]+ba")
        tries.append(f"bv*[height<={height}][filesize_approx<{cap}]+ba")
    for height in ladder:
        tries.append(f"b[height<={height}][filesize_approx<{cap}]")
    # Last resorts: formats that never report a size, then anything at
    # all. --max-filesize still backstops both.
    tries += [f"bv*[height<={h}][vcodec^=avc1]+ba", f"bv*[height<={h}]+ba", f"b[height<={h}]", "b"]
    return "/".join(tries)


async def _video_check(path: pathlib.Path) -> bool | None:
    """True / False / None — has video, has none, or could not tell.

    Three answers, not two. The first version returned a bool and folded
    "could not tell" into "no video", so any probe that failed for its
    own reasons rejected a perfectly good download. Every YouTube fetch
    started failing with a message about the file, when the problem was
    the question.

    Built on the same JSON shape queue.probe uses, which is the one
    known to work here, rather than a second invocation of my own.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error",
            "-show_entries", "stream=codec_type",
            "-of", "json",
            str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        data = json.loads(out or b"{}")
    except (OSError, asyncio.TimeoutError, ValueError) as e:
        logger.warning("could not probe %s for video: %s", path, e)
        return None
    streams = data.get("streams")
    if not isinstance(streams, list) or not streams:
        # No stream list at all is the probe not answering, not a file
        # with nothing in it.
        return None
    return any(st.get("codec_type") == "video" for st in streams)


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

        # The merged file, not a leftover fragment.
        #
        # `bv*+ba` downloads video and audio separately and merges them,
        # writing intermediates named <id>.f399.webm / <id>.f251.webm.
        # Those share the merged file's suffix, so a glob on <id>.* that
        # takes the first match can hand back the AUDIO-only fragment —
        # which opens fine and then fails at `-map 0:v` with "Stream map
        # matches no streams", once per restart, forever.
        candidates = [
            p
            for p in queue.MEDIA_DIR.glob(f"{job_id}.*")
            if p.suffix.lower() in queue.VIDEO_SUFFIXES
        ]
        # Exact stem is the merged output; anything with a format id in
        # the middle is an intermediate yt-dlp did not clean up.
        media = next((p for p in candidates if p.stem == job_id), None)
        if media is None:
            media = next(iter(sorted(candidates, key=lambda p: -p.stat().st_size)), None)
        if media is None:
            raise RuntimeError("nothing downloadable at that URL")

        # Confirm it can actually be played before it becomes a queue
        # item. A file with no video track is not a clip, and finding
        # that out at play time means the stream drops instead — the
        # camera goes offline for a bad download.
        # Only reject on a definite no. An inconclusive probe lets the
        # file through — the pump now retires a clip that exits
        # immediately, so a bad one costs one restart instead of an
        # endless loop, which is a far better trade than refusing
        # downloads that are fine.
        if await _video_check(media) is False:
            # Distinguish the two reasons a file can arrive audio-only.
            # "That URL offers audio only" and "the video was too big to
            # keep" look identical on disk and need completely different
            # things from the operator.
            noise = err.decode("utf-8", "replace").lower()
            if "max-filesize" in noise or "larger than" in noise:
                raise RuntimeError(
                    f"the video is larger than the {MAX_BYTES // (1024 * 1024)} MB "
                    "limit, so only its audio was kept. Try a shorter video — a "
                    "virtual camera loops a clip, so a couple of minutes is "
                    "usually the useful length anyway."
                )
            raise RuntimeError(
                "that download has no video track — it may have been "
                "interrupted, or the URL offers audio only"
            )

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
    # These read like transient network trouble and are not. They mean the
    # extractor is older than the site it is extracting from, which is a
    # thing that happens to yt-dlp continuously and is fixed by installing
    # a newer one -- not by retrying, which is what the wording invites.
    stale = (
        "needs to be reloaded",
        "Sign in to confirm",
        "Please report this issue",
        "unable to extract",
        "nsig extraction failed",
    )
    if any(marker.lower() in stderr.lower() for marker in stale):
        return (
            f"{last.removeprefix('ERROR: ').strip()} — this usually means the "
            "downloader is out of date for that site. Rebuild the backend to "
            "pick up a newer yt-dlp."
        )
    return last.removeprefix("ERROR: ").strip() or "download failed"
