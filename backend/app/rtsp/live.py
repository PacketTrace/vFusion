"""Resolving a live URL to something ffmpeg can read.

Distinct from ``fetch.py``, which downloads a video to a file for the
queue to play. A live stream never finishes downloading, so that path
cannot work at all -- the whole point here is that nothing is stored.

Two kinds of URL arrive:

* Something ffmpeg already understands -- an ``.m3u8``, ``rtsp://``,
  ``rtmp://``, a plain progressive file. Passed straight through. No
  resolver, nothing to go stale, nothing to break on somebody else's
  release schedule.
* A page that *contains* a stream -- a YouTube live watch URL. yt-dlp
  turns that into a manifest URL.

The second kind carries a cost the first does not: the manifest URL is
signed and expires, so it has to be resolved again when the stream
drops rather than reused. ``resolve`` is therefore cheap to call and
never cached here -- the pump decides when to ask again.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any


logger = logging.getLogger(__name__)

RESOLVE_TIMEOUT_SEC = 45
PROBE_TIMEOUT_SEC = 20

# Schemes and extensions ffmpeg opens directly. Anything here skips
# yt-dlp entirely, which is the preferred path: the resolver tracks
# sites that change under it, and a camera that goes down because a
# scraper went stale is a poor trade.
_DIRECT = re.compile(
    r"^(rtsp|rtsps|rtmp|rtmps|srt|udp|hls)://"
    r"|\.(m3u8|mpd|ts|mp4|mkv|flv|webm)(\?|$)",
    re.I,
)


def is_direct(url: str) -> bool:
    return bool(_DIRECT.search((url or "").strip()))


class LiveError(RuntimeError):
    """Could not turn the URL into a stream."""


async def _yt_dlp_url(url: str) -> tuple[str, str | None]:
    """(stream url, title) from a page yt-dlp understands."""
    proc = await asyncio.create_subprocess_exec(
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        # Cap the pull. A 4K60 source will swamp the encoder in a way a
        # downloaded clip never did, because there is no chance to
        # transcode it ahead of time.
        "-f",
        "best[height<=1080]/bestvideo[height<=1080]+bestaudio/best",
        "--get-url",
        "--get-title",
        url,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(
            proc.communicate(), timeout=RESOLVE_TIMEOUT_SEC
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise LiveError("timed out resolving the URL")
    if proc.returncode != 0:
        last = [
            ln for ln in err.decode("utf-8", "replace").splitlines() if ln.strip()
        ]
        raise LiveError(last[-1] if last else "yt-dlp could not resolve the URL")

    lines = [ln for ln in out.decode("utf-8", "replace").splitlines() if ln.strip()]
    if not lines:
        raise LiveError("yt-dlp returned no stream URL")
    # --get-title prints the title first, then one URL per selected
    # stream. More than one means separate video and audio, which the
    # single-input encoder path cannot take.
    title = lines[0] if len(lines) > 1 else None
    urls = lines[1:] if len(lines) > 1 else lines
    if len(urls) > 1:
        raise LiveError(
            "that URL resolves to separate video and audio streams, which "
            "this encoder cannot combine — pick a source with a muxed "
            "format, or paste a direct .m3u8"
        )
    return urls[0], title


async def has_audio(url: str) -> bool:
    """Does the stream carry audio?

    The encoder's audio input has to keep receiving samples — starve it
    and it stalls, which stalls the muxer, and the video goes down with
    it. A clip is probed when it is added; a live source has to be asked
    at connect time, and being wrong costs the whole stream, so a failed
    probe answers "no" and substitutes silence.
    """
    proc = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        url,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=PROBE_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return False
    return b"audio" in out


async def resolve(url: str) -> dict[str, Any]:
    """{stream, title, audio} for a live source, resolved fresh."""
    url = (url or "").strip()
    if not url:
        raise LiveError("no URL set")
    if is_direct(url):
        stream, title = url, None
    else:
        stream, title = await _yt_dlp_url(url)
    return {"stream": stream, "title": title, "audio": await has_audio(stream)}
