"""Thresholds a detection has to clear before vFusion reports it.

The camera reports things that are not there. Measured over 227 recorded
tracks on one camera: 221 of them never moved more than 2% of the frame
and clustered into three grid cells — the same two or three spots in the
upper-left, over and over. A fixed object read as a person, several
hundred times a day.

Two properties separate that from a real detection:

* **Size.** Every false positive occupied under 0.6% of the frame; every
  real one over 2.6%. A four-fold gap, and the reason area is the
  default filter rather than movement.
* **Movement.** Real subjects crossed 2.5-47% of the frame. But a person
  genuinely standing still is a real detection, so movement is offered
  and left off — it trades false positives for false negatives, and
  which of those costs more depends on what the camera is for.

Stored in a file rather than a settings row: it belongs to the MQTT
feature, changes when someone drags a slider, and is not worth a schema
migration.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

STORE_PATH = Path(os.environ.get("MQTT_FILTERS_FILE", "/app/data/mqtt/filters.json"))

# Fraction of the frame a box must occupy. 1% sits in the middle of the
# gap measured above: it drops every false positive seen and keeps every
# real detection.
DEFAULT_MIN_AREA = 0.01

# Fraction of the frame a track must traverse. Off by default — a real
# subject standing still should still be reported.
DEFAULT_MIN_MOVEMENT = 0.0

_lock = asyncio.Lock()
_cache: dict[str, float] | None = None


def _defaults() -> dict[str, float]:
    return {
        "min_area": DEFAULT_MIN_AREA,
        "min_movement": DEFAULT_MIN_MOVEMENT,
    }


def get() -> dict[str, float]:
    """Current thresholds. Cached — this is read on every message."""
    global _cache
    if _cache is not None:
        return _cache
    try:
        data = json.loads(STORE_PATH.read_text())
    except FileNotFoundError:
        data = {}
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("filters unreadable (%s); using defaults", e)
        data = {}
    merged = _defaults()
    if isinstance(data, dict):
        for key in merged:
            value = data.get(key)
            if isinstance(value, (int, float)) and value >= 0:
                merged[key] = float(value)
    _cache = merged
    return merged


async def put(min_area: float, min_movement: float) -> dict[str, float]:
    global _cache
    entry = {
        # Clamped: a threshold above a quarter of the frame would reject
        # everything, which reads as the feature being broken.
        "min_area": max(0.0, min(float(min_area), 0.25)),
        "min_movement": max(0.0, min(float(min_movement), 0.5)),
    }
    async with _lock:
        try:
            STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = STORE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(entry))
            tmp.replace(STORE_PATH)
        except OSError as e:
            logger.warning("could not persist filters: %s", e)
        _cache = entry
    return entry


def describe() -> dict[str, Any]:
    current = get()
    return {
        **current,
        "defaults": _defaults(),
        "note": (
            "Area is the reliable filter: measured false positives all sat "
            "under 0.6% of frame while real detections were above 2.6%. "
            "Movement is off by default because a subject standing still is "
            "still a subject."
        ),
    }
