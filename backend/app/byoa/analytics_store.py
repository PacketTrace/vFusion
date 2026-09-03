"""Analytics somebody described in words, kept so they can be reused.

A BYOA analytic is three things that have to agree with each other: a
prompt that forces JSON out of the model, a Helix event type with an
attribute per field, and a mapping tying one to the other. Getting them
to agree by hand is the fiddly part, and once someone has a working set
it should not evaporate on reload.

File-backed rather than a table. ``prompt_templates`` stores a name and a
value and nothing else, so it cannot hold the pairing, and adding columns
would make every operator run a schema migration to save a prompt. Same
reasoning as the other stores here -- this is rebuildable content, not
records.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


logger = logging.getLogger(__name__)

STORE_PATH = Path(
    os.environ.get("BYOA_ANALYTICS_FILE", "/app/data/byoa/analytics.json")
)

_lock = asyncio.Lock()


def _load() -> list[dict[str, Any]]:
    try:
        data = json.loads(STORE_PATH.read_text())
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("analytics store unreadable (%s); starting empty", e)
        return []
    return data if isinstance(data, list) else []


def _save(items: list[dict[str, Any]]) -> None:
    try:
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STORE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(items, indent=1))
        tmp.replace(STORE_PATH)
    except OSError as e:
        logger.warning("could not persist analytics: %s", e)


def list_all() -> list[dict[str, Any]]:
    return _load()


async def add(analytic: dict[str, Any]) -> dict[str, Any]:
    """Store one analytic. Name collisions overwrite, so refining a
    generated analytic and saving it again replaces it rather than
    leaving two entries a character apart in the picker."""
    entry = {
        **analytic,
        "id": analytic.get("id") or uuid4().hex,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    async with _lock:
        # Drop by id as well as by name, so renaming while editing moves
        # the entry rather than leaving the old name behind alongside it.
        items = [
            i
            for i in _load()
            if i.get("name") != entry.get("name") and i.get("id") != entry["id"]
        ]
        items.append(entry)
        _save(items)
    return entry


async def remove(analytic_id: str) -> bool:
    async with _lock:
        items = _load()
        kept = [i for i in items if i.get("id") != analytic_id]
        if len(kept) == len(items):
            return False
        _save(kept)
    return True
