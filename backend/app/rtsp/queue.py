"""What is waiting to be shown, and what has been shown already.

A list in a JSON file next to the media it describes. Same reasoning as
the other file-backed stores here: it belongs to this feature, it
changes when someone drags a file onto a page, and it is not worth a
schema migration.

Played items are kept rather than deleted. "It played and you missed
it" and "it never played" look identical once a row disappears, and the
first thing anyone asks when a clip does not show up in Command is which
of those happened.
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


logger = logging.getLogger(__name__)

MEDIA_DIR = Path(os.environ.get("RTSP_MEDIA_DIR", "/app/data/rtsp/media"))
QUEUE_PATH = Path(os.environ.get("RTSP_QUEUE_FILE", "/app/data/rtsp/queue.json"))

# A still gets this long on screen unless asked otherwise. Long enough
# to be unmissable in a recording, short enough not to feel stuck.
DEFAULT_IMAGE_SECONDS = 10

VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm", ".ts"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

_lock = asyncio.Lock()

# Set whenever something lands in the queue, so the pump can cut standby
# short instead of discovering the new item on its next poll.
arrived = asyncio.Event()


def _load() -> list[dict[str, Any]]:
    try:
        data = json.loads(QUEUE_PATH.read_text())
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("rtsp queue unreadable (%s); starting empty", e)
        return []
    return data if isinstance(data, list) else []


def _save(items: list[dict[str, Any]]) -> None:
    try:
        QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = QUEUE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(items))
        tmp.replace(QUEUE_PATH)
    except OSError as e:
        logger.warning("could not persist rtsp queue: %s", e)


def list_all() -> list[dict[str, Any]]:
    return _load()


def next_pending() -> dict[str, Any] | None:
    for item in _load():
        if not item.get("played_at"):
            return item
    return None


async def probe(path: Path) -> tuple[bool, float]:
    """(has an audio track, duration in seconds).

    Both, from one ffprobe, because a source without audio needs both
    answers: it gets silence substituted, and silence is infinite. Only
    the duration tells that source when to stop, and without it the
    process never exits, the clip never advances, and the stream freezes
    on the last frame it managed to send.

    Asked once, at add time, and remembered. Probing when a clip starts
    would put a subprocess in the gap between one ending and the next
    beginning, which is the one place the gap is visible.

    Unprobeable counts as no audio and no duration: silence is wrong
    quietly, where mapping a track that is not there fails the source
    outright.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration:stream=codec_type",
            "-of", "json",
            str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        data = json.loads(out or b"{}")
    except (OSError, asyncio.TimeoutError, ValueError) as e:
        logger.warning("could not probe %s: %s", path, e)
        return False, 0.0
    audio = any(
        s.get("codec_type") == "audio" for s in data.get("streams") or []
    )
    try:
        duration = float((data.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    return audio, duration


async def ensure_duration(item: dict[str, Any]) -> float:
    """The item's duration, probing and remembering it if unknown.

    Entries written before durations were recorded have none, and a
    source with substituted silence cannot end without one. Probing here
    costs a gap once per legacy item rather than leaving it unplayable.
    """
    known = item.get("duration")
    if isinstance(known, (int, float)) and known > 0:
        return float(known)
    _, duration = await probe(Path(item["path"]))
    if duration > 0:
        async with _lock:
            items = _load()
            for row in items:
                if row.get("id") == item.get("id"):
                    row["duration"] = duration
            _save(items)
        item["duration"] = duration
    return duration


def _probed(result: tuple[bool, float]) -> dict[str, Any]:
    audio, duration = result
    return {"has_audio": audio, "duration": duration}


def kind_for(filename: str) -> str | None:
    suffix = Path(filename).suffix.lower()
    if suffix in VIDEO_SUFFIXES:
        return "video"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    return None


async def add(filename: str, data: bytes, seconds: int | None = None) -> dict[str, Any]:
    kind = kind_for(filename)
    if kind is None:
        raise ValueError(f"unsupported file type: {Path(filename).suffix or filename}")

    item_id = uuid.uuid4().hex
    # Keep the extension: ffmpeg sniffs content, but a demuxer given a
    # matching extension picks the right one first time.
    stored = MEDIA_DIR / f"{item_id}{Path(filename).suffix.lower()}"
    async with _lock:
        try:
            MEDIA_DIR.mkdir(parents=True, exist_ok=True)
            stored.write_bytes(data)
        except OSError as e:
            raise RuntimeError(f"could not store upload: {e}") from e
        entry = {
            "id": item_id,
            "name": Path(filename).name,
            "path": str(stored),
            "kind": kind,
            **_probed(await probe(stored) if kind == "video" else (False, 0.0)),
            "seconds": int(seconds or DEFAULT_IMAGE_SECONDS) if kind == "image" else None,
            "bytes": len(data),
            "added_at": datetime.now(timezone.utc).isoformat(),
            "played_at": None,
        }
        items = _load()
        items.append(entry)
        _save(items)
    arrived.set()
    return entry


async def adopt(path: Path, display_name: str) -> dict[str, Any]:
    """Queue a file that is already on disk, without copying it.

    ``add`` takes bytes because an upload arrives as bytes. A fetched
    video is already a file, and reading half a gigabyte into memory to
    write it back out next to itself would be work done for the shape of
    an interface rather than for any result.
    """
    entry = {
        "id": path.stem,
        "name": Path(display_name).name,
        "path": str(path),
        "kind": "video",
        **_probed(await probe(path)),
        "seconds": None,
        "bytes": path.stat().st_size if path.is_file() else 0,
        "added_at": datetime.now(timezone.utc).isoformat(),
        "played_at": None,
    }
    async with _lock:
        items = _load()
        items.append(entry)
        _save(items)
    arrived.set()
    return entry


async def mark_played(item_id: str) -> None:
    async with _lock:
        items = _load()
        for item in items:
            if item.get("id") == item_id:
                item["played_at"] = datetime.now(timezone.utc).isoformat()
        _save(items)


async def requeue(item_id: str) -> bool:
    """Play it again. Clears the played stamp and moves it to the back."""
    async with _lock:
        items = _load()
        found = next((i for i in items if i.get("id") == item_id), None)
        if not found:
            return False
        items = [i for i in items if i.get("id") != item_id]
        found["played_at"] = None
        items.append(found)
        _save(items)
    arrived.set()
    return True


async def remove(item_id: str) -> bool:
    async with _lock:
        items = _load()
        found = next((i for i in items if i.get("id") == item_id), None)
        if not found:
            return False
        _save([i for i in items if i.get("id") != item_id])
    try:
        Path(found["path"]).unlink(missing_ok=True)
    except OSError as e:
        logger.warning("could not delete %s: %s", found.get("path"), e)
    return True


async def clear_played() -> int:
    async with _lock:
        items = _load()
        played = [i for i in items if i.get("played_at")]
        _save([i for i in items if not i.get("played_at")])
    for item in played:
        try:
            Path(item["path"]).unlink(missing_ok=True)
        except OSError:
            pass
    return len(played)
