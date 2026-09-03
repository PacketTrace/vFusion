"""Completed tracks, appended to a file so they can be reviewed later.

The live view answers "what is there now" and forgets. Reviewing what
happened at 3am needs the opposite, but persisting the raw stream is not
the way to get it: 8 messages a second per object is a lot of rows for
data that is only interesting in aggregate.

So this records *tracks*, not messages. One record per object, written
when the object leaves view, holding its path and how long it stayed.
A person crossing the porch becomes a single row with a shape, rather
than four hundred bounding boxes.

JSONL on the ``webhook_assets`` volume rather than a table -- the same
reasoning as the other file-backed stores here: this is derived data
that rebuilds itself as cameras keep publishing, and it is not worth
making every operator run a schema migration for.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

HISTORY_DIR = Path(os.environ.get("MQTT_HISTORY_DIR", "/app/data/mqtt/tracks"))

# Tracks shorter than this are noise -- a detection that flickered once and
# vanished tells you nothing and would drown the interesting rows.
MIN_DURATION_SEC = 0.75

# Keep files from growing without bound on a busy camera. At one line per
# track this is generous; a day of heavy traffic is a few thousand.
MAX_LINES_PER_FILE = 50_000

# Days of history to keep. Old files are removed on write.
RETENTION_DAYS = 30


def _path_for(when: datetime) -> Path:
    return HISTORY_DIR / f"{when.date().isoformat()}.jsonl"


def record(entry: dict[str, Any]) -> None:
    """Append one completed track. Never raises into the ingest loop."""
    try:
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        path = _path_for(datetime.now(timezone.utc))
        with path.open("a") as fh:
            fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except OSError as e:
        logger.warning("could not record track: %s", e)


def prune() -> None:
    """Drop files older than the retention window."""
    try:
        cutoff = datetime.now(timezone.utc).date().toordinal() - RETENTION_DAYS
        for path in HISTORY_DIR.glob("*.jsonl"):
            try:
                day = datetime.fromisoformat(path.stem).date()
            except ValueError:
                continue
            if day.toordinal() < cutoff:
                path.unlink()
    except OSError as e:
        logger.warning("could not prune track history: %s", e)


def read(
    camera_id: str | None = None,
    limit: int = 200,
    object_type: str | None = None,
) -> list[dict[str, Any]]:
    """Most recent tracks first.

    Reads newest files first and stops once ``limit`` is reached, so the
    common case -- "what happened recently" -- never touches old files.
    """
    out: list[dict[str, Any]] = []
    try:
        files = sorted(HISTORY_DIR.glob("*.jsonl"), reverse=True)
    except OSError:
        return out

    for path in files:
        try:
            lines = path.read_text().splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            if len(out) >= limit:
                return out
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if camera_id and entry.get("camera_id") != camera_id:
                continue
            if object_type and entry.get("type") != object_type:
                continue
            out.append(entry)
    return out


def summarize(camera_id: str | None = None, limit: int = 2000) -> dict[str, Any]:
    """Counts by type and by hour, for a sense of shape over time."""
    entries = read(camera_id=camera_id, limit=limit)
    by_type: dict[str, int] = {}
    by_hour: dict[str, int] = {}
    durations: list[float] = []
    for e in entries:
        by_type[e.get("type", "unknown")] = by_type.get(e.get("type", "unknown"), 0) + 1
        started = str(e.get("started_at") or "")
        if len(started) >= 13:
            by_hour[started[:13]] = by_hour.get(started[:13], 0) + 1
        if isinstance(e.get("duration_sec"), (int, float)):
            durations.append(float(e["duration_sec"]))
    durations.sort()
    return {
        "total": len(entries),
        "by_type": by_type,
        "by_hour": dict(sorted(by_hour.items())),
        "median_duration_sec": (
            round(durations[len(durations) // 2], 2) if durations else None
        ),
    }
