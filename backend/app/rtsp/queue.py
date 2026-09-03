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
