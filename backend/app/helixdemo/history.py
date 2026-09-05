"""What was seeded, so it can be seeded again.

The seeder returns a ``seed`` value precisely so a run can be repeated
deliberately rather than by luck — and then nothing kept it, so the
number was gone the moment the page changed. Worse, the *design* was
gone with it: the composed spec is what you would want back when a
customer asks for the products to be hardware rather than groceries.

So this keeps the design and the parameters, not the events. Re-running
posts fresh events by default, because that is what people do with a
demo — the same-seed repeat exists but is not the offer, since vFusion
cannot delete what it posted and a byte-identical re-run doubles the
timeline rather than replacing it.

A file on the assets volume, like every other operational store here.
Not worth a migration, and it is a list of at most a few dozen small
objects.
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

STORE_PATH = Path(
    os.environ.get("HELIX_DEMO_HISTORY_FILE", "/app/data/helixdemo/history.json")
)

# Enough to find the one from last week's demo, few enough that the file
# stays small and the list stays readable.
MAX_ENTRIES = 40

_lock = asyncio.Lock()


async def load() -> list[dict[str, Any]]:
    """Newest first. Never raises — history is a convenience, and losing
    it must not take a working seeder down with it."""
    try:
        async with _lock:
            raw = STORE_PATH.read_text(encoding="utf-8")
    except OSError:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("helix demo history is unreadable; starting a new one")
        return []
    return data if isinstance(data, list) else []


async def _write(entries: list[dict[str, Any]]) -> None:
    try:
        async with _lock:
            STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = STORE_PATH.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(entries[:MAX_ENTRIES], separators=(",", ":")),
                encoding="utf-8",
            )
            tmp.replace(STORE_PATH)
    except OSError:
        logger.warning("could not persist helix demo history", exc_info=True)


async def record(entry: dict[str, Any]) -> dict[str, Any]:
    """Note one seeding run. Returns the stored entry."""
    entries = await load()
    stored = {
        "id": str(uuid.uuid4()),
        "at": datetime.now(timezone.utc).isoformat(),
        **entry,
    }
    await _write([stored, *entries])
    return stored


async def remove(entry_id: str) -> bool:
    entries = await load()
    kept = [e for e in entries if e.get("id") != entry_id]
    if len(kept) == len(entries):
        return False
    await _write(kept)
    return True
