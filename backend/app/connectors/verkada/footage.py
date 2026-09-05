"""Pull historical footage out of Verkada via HLS + ffmpeg.

The two public entry points used by flow actions are:

  - ``get_stream_key(api_key, org_id)`` — short-lived JWT for HLS auth.
    Cached in-process with a small TTL safety margin.
  - ``grab_video_clip(api_key, org_id, camera_id, start_epoch, ...)``
    — shells out to ffmpeg to download a transcoded H.264 MP4 clip
    from a historical window.

Auth tokens (POST /token) are handled by ``VerkadaClient`` directly;
we only need the stream key here.

ffmpeg must be present in PATH (the backend image installs it).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

from app.connectors.verkada.client import normalize_base_url


logger = logging.getLogger(__name__)


STREAM_KEY_TTL_SEC = 500  # Verkada grants 600s; refresh a bit early


class FootageError(RuntimeError):
    pass


# Query params whose values are credentials. ffmpeg echoes the full input
# URL back in its stderr, so anything we surface from stderr — exception
# message, log line, or run-event log — carries a live stream JWT unless
# it's scrubbed first. The token is valid for ~10 minutes and grants
# footage access to the whole org.
_SECRET_QS_KEYS = ("jwt", "api_key", "token", "x-verkada-auth")
_SECRET_QS_RE = re.compile(
    r"\b(" + "|".join(_SECRET_QS_KEYS) + r")=([^&\s\"']+)",
    re.IGNORECASE,
)


def redact(text: str) -> str:
    """Strip credential query-string values out of ffmpeg/HTTP noise.

    Keeps the parameter name (useful when reading a failure) and drops the
    value. Always run this over subprocess stderr before it reaches a user,
    a log, or an exception message.
    """
    return _SECRET_QS_RE.sub(lambda m: f"{m.group(1)}=***redacted***", text)


# Module-level cache keyed by (api_key, org_id, base_url) — refreshed lazily.
# Including base_url in the key prevents a token minted against the US region
# from being served back to an EU caller (or vice versa) when a single host
# happens to manage multiple orgs in different regions.
_stream_keys: dict[tuple[str, str, str], tuple[str, float]] = {}


async def get_stream_key(
    api_key: str,
    org_id: str,
    force_refresh: bool = False,
    base_url: str | None = None,
) -> str:
    """Return a cached HLS stream JWT, refreshing when stale.

    ``base_url`` defaults to the US region (``api.verkada.com``); pass the
    connection's ``region`` value (e.g. ``https://api.eu.verkada.com``)
    for EU orgs. The token endpoint is region-specific — a token minted
    on the US host will not authenticate against EU stream URLs.
    """
    base = normalize_base_url(base_url)
    cache_key = (api_key, org_id, base)
    now = time.time()
    if not force_refresh:
        cached = _stream_keys.get(cache_key)
        if cached and now < cached[1]:
            return cached[0]
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(
            f"{base}/cameras/v1/footage/token",
            params={"expiration": 600, "org_id": org_id},
            headers={"accept": "application/json", "x-api-key": api_key},
        )
    if res.status_code >= 400:
        raise FootageError(f"stream-key fetch failed: {res.status_code} {res.text[:200]!r}")
    jwt = res.json().get("jwt")
    if not jwt or not isinstance(jwt, str):
        raise FootageError(f"stream-key response missing 'jwt': {res.text[:200]!r}")
    _stream_keys[cache_key] = (jwt, now + STREAM_KEY_TTL_SEC)
    return jwt


async def grab_video_clip(
    *,
    api_key: str,
    org_id: str,
    camera_id: str,
    start_epoch: int | None,
    duration_sec: float,
    out_path: Path,
    buffer_sec: float = 0.0,
    timeout_sec: int = 90,
    progress: Any = None,
    base_url: str | None = None,
    audio: str = "none",
) -> int:
    """Transcode a short historical clip to ``out_path``. Returns the
    file size on success; raises ``FootageError`` otherwise.

    ``audio`` selects what gets kept:

    ``"none"``  video only (the default, and what every existing caller
                wants -- Gemini is charged per frame, so an audio track
                nobody reads is pure cost).
    ``"only"``  audio only, AAC in an .m4a. Roughly an eighth the tokens
                of the same span as video, which is the entire reason
                the audio analytic extracts rather than sending the MP4.
    ``"both"``  both streams, for when a prompt needs to see and hear.

    ``start_epoch`` of ``None`` records from the LIVE edge instead of
    the archive: the same stream URL with no time window, which is what
    the live still frame already uses. It costs ``duration_sec`` of real
    wall-clock, because the footage does not exist yet -- ffmpeg sits
    there and captures it as it arrives.

    A camera whose microphone is off, or whose footage simply carries no
    audio track, makes ffmpeg exit non-zero with "Output file does not
    contain any stream" under ``"only"``. That is deliberate: an empty
    .m4a would reach Gemini and come back as a confident "silence",
    which is indistinguishable from a room where nobody spoke.

    Built for downstream Gemini upload — H.264 yuv420p is the broadest
    compatibility codec. Retries once with a fresh stream key on the
    first failure (which usually means an expired JWT).

    If ``progress`` is provided (a StepProgress instance from the worker),
    ffmpeg stderr lines and retry notes are forwarded to it as log messages
    for the run-events panel."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    live = start_epoch is None
    end_epoch = (
        None if live else start_epoch + int(max(2, buffer_sec + duration_sec + 2))
    )
    base = normalize_base_url(base_url)

    last_err: str | None = None
    for attempt in (1, 2):
        if progress and attempt == 2:
            await progress.log("ffmpeg retrying with fresh stream key")
        key = await get_stream_key(
            api_key, org_id, force_refresh=(attempt == 2), base_url=base
        )
        url = (
            f"{base}/stream/cameras/v1/footage/stream/stream.m3u8"
            f"?org_id={org_id}"
            f"&camera_id={camera_id}"
            f"&resolution=high_res"
            f"&jwt={key}"
            f"&type=stream"
            f"&codec=hevc"
            f"&transcode=false"
        )
        if not live:
            url += f"&start_time={start_epoch}&end_time={end_epoch}"
        video_args = [
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
        ]
        # 64k mono AAC. Speech survives it comfortably and the file stays
        # small enough that the Files API upload is not the slow part.
        audio_args = ["-c:a", "aac", "-b:a", "64k", "-ac", "1"]
        if audio == "only":
            codec_args = ["-vn", *audio_args]
        elif audio == "both":
            codec_args = [*video_args, *audio_args]
        else:
            codec_args = ["-an", *video_args]
        cmd = [
            "ffmpeg", "-y",
            "-loglevel", "error",
            "-i", url,
            # Seeking into a live stream has nothing to seek past — the
            # only footage there is arrives from now on.
            *([] if live else ["-ss", str(max(0.0, buffer_sec))]),
            "-t", str(duration_sec),
            *codec_args,
            "-movflags", "+faststart",
            str(out_path),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            # A live capture cannot finish sooner than the span it is
            # recording, so the timeout has to clear it with room to
            # spare or every live grab dies at the deadline.
            deadline = (
                max(timeout_sec, duration_sec + 30) if live else timeout_sec
            )
            _, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=deadline
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            last_err = "ffmpeg timed out"
            continue
        if proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
            return out_path.stat().st_size
        last_err = redact(
            stderr_bytes.decode(errors="replace").strip()
        )[:500] or f"rc={proc.returncode}"
        if progress:
            await progress.log(f"ffmpeg attempt {attempt} failed: {last_err}")
        logger.warning(
            "grab_video_clip attempt %d failed for %s: %s",
            attempt, camera_id, last_err,
        )

    if audio == "only" and last_err and "does not contain any stream" in last_err:
        raise FootageError(
            "this camera's footage has no audio track — the microphone is "
            "off, or the model has no mic"
        )
    raise FootageError(f"grab_video_clip failed: {last_err}")


CLIP_ROOT = Path(os.environ.get("CLIP_DIR", "/app/data/clips"))
CLIP_RETENTION_HOURS = int(os.environ.get("CLIP_RETENTION_HOURS", "168"))  # 1 week
IMAGE_ROOT = Path(os.environ.get("IMAGE_DIR", "/app/data/images"))
IMAGE_RETENTION_HOURS = int(os.environ.get("IMAGE_RETENTION_HOURS", "168"))


async def grab_still_frame(
    *,
    api_key: str,
    org_id: str,
    camera_id: str,
    out_path: Path,
    timeout_sec: int = 45,
    progress: Any = None,
    base_url: str | None = None,
    start_epoch: int | None = None,
) -> int:
    """Pull a single frame from the camera's HLS stream as a JPEG.

    Same HLS endpoint as ``grab_video_clip`` (footage stream view).
    Without ``start_epoch`` the URL serves the live segment list and
    ffmpeg's ``-frames:v 1`` grabs the first frame it decodes; with one
    it asks for a short window at that moment and takes the first frame
    of that instead.

    The window matters because it is the same footage a clip comes
    from. The stored-thumbnail endpoint is a different archive with
    different retention, and asking it for a moment the stream can serve
    perfectly well returns 404 on some cameras and an image on others —
    which reads as "no footage" about footage that exists.

    Returns file size on success or raises ``FootageError``.

    Retries once with a fresh stream key on the first failure (matches
    grab_video_clip semantics — usually an expired JWT)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    base = normalize_base_url(base_url)

    last_err: str | None = None
    for attempt in (1, 2):
        if progress and attempt == 2:
            await progress.log("ffmpeg retrying with fresh stream key")
        key = await get_stream_key(
            api_key, org_id, force_refresh=(attempt == 2), base_url=base
        )
        url = (
            f"{base}/stream/cameras/v1/footage/stream/stream.m3u8"
            f"?org_id={org_id}"
            f"&camera_id={camera_id}"
            f"&resolution=high_res"
            f"&jwt={key}"
            f"&type=stream"
        )
        if start_epoch is not None:
            # A few seconds, not an instant: HLS is segmented, so a
            # zero-length window can land between segments and produce
            # nothing at all.
            url += f"&start_time={start_epoch}&end_time={start_epoch + 4}"
        cmd = [
            "ffmpeg", "-y",
            "-loglevel", "error",
            "-i", url,
            "-frames:v", "1",
            "-q:v", "2",
            "-f", "image2",
            str(out_path),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            last_err = "ffmpeg timed out"
            continue
        if proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
            return out_path.stat().st_size
        last_err = redact(
            stderr_bytes.decode(errors="replace").strip()
        )[:500] or f"rc={proc.returncode}"
        if progress:
            await progress.log(f"ffmpeg attempt {attempt} failed: {last_err}")
        logger.warning(
            "grab_still_frame attempt %d failed for %s: %s",
            attempt, camera_id, last_err,
        )

    raise FootageError(f"grab_still_frame failed: {last_err}")


def _cleanup_dir(root: Path, retention_hours: int) -> int:
    if not root.exists():
        return 0
    cutoff = time.time() - retention_hours * 3600
    removed = 0
    for child in root.iterdir():
        if not child.is_file():
            continue
        try:
            if child.stat().st_mtime < cutoff:
                child.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def cleanup_old_clips(
    clip_retention_hours: int | None = None,
    image_retention_hours: int | None = None,
) -> dict[str, int]:
    """Delete clip + image files older than the given retention windows.

    Each window can be ``None`` or ``0`` to skip (= unlimited / never
    delete). Idempotent. Defaults fall back to the env-driven constants
    so legacy code paths keep working.
    """
    if clip_retention_hours is None:
        clip_retention_hours = CLIP_RETENTION_HOURS
    if image_retention_hours is None:
        image_retention_hours = IMAGE_RETENTION_HOURS
    clips = (
        _cleanup_dir(CLIP_ROOT, clip_retention_hours)
        if clip_retention_hours and clip_retention_hours > 0
        else 0
    )
    images = (
        _cleanup_dir(IMAGE_ROOT, image_retention_hours)
        if image_retention_hours and image_retention_hours > 0
        else 0
    )
    if clips or images:
        logger.info("media cleanup: clips=%d images=%d", clips, images)
    return {"removed": clips + images, "clips": clips, "images": images}
