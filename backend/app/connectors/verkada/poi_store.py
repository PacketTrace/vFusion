"""Synced Persons of Interest, kept in a file rather than a table.

Why sync at all: the trigger filter picker suggests values it has seen in
past webhooks, and a Person of Interest who hasn't walked past a camera
yet has never appeared in one. On this org that's the difference between
2 labels and 9 — a filter for someone who exists in Command but hasn't
been recorded is impossible to build from webhook history alone.

Why a file: this is a cache of somebody else's data, rebuildable at any
time by pressing sync again, and adding a table would make every operator
run a schema migration for it. Lives on the ``webhook_assets`` volume
alongside the MCP tool history, for the same reasons.

Shape on disk:

    {"<connection id>": {"synced_at": "<iso>",
                         "people": [{"person_id", "label", "last_seen"}]}}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

STORE_PATH = Path(
    os.environ.get("VERKADA_POI_FILE", "/app/data/verkada/people-of-interest.json")
)

_lock = asyncio.Lock()


def _load() -> dict[str, Any]:
    try:
        return json.loads(STORE_PATH.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as e:
        # A cache — losing it costs a sync, not data.
        logger.warning("POI store unreadable (%s); starting empty", e)
        return {}


def _save(data: dict[str, Any]) -> None:
    try:
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STORE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=0, sort_keys=True))
        tmp.replace(STORE_PATH)
    except OSError as e:
        logger.warning("could not persist POI store: %s", e)


async def put(connection_id: str, people: list[dict[str, Any]]) -> int:
    """Replace the stored people for one connection. Returns the count."""
    cleaned = [
        {
            "person_id": p.get("person_id"),
            "label": p.get("label"),
            "last_seen": p.get("last_seen"),
        }
        for p in people
        if isinstance(p, dict) and p.get("label")
    ]
    async with _lock:
        store = _load()
        store[str(connection_id)] = {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "people": cleaned,
        }
        _save(store)
    return len(cleaned)


def labels(connection_id: str | None = None) -> list[str]:
    """Known Person of Interest labels, newest sync wins.

    Without a connection id, returns the union across every synced
    connection — the filter picker doesn't always know which org a flow
    will end up bound to.
    """
    store = _load()
    entries = (
        [store.get(str(connection_id))]
        if connection_id is not None
        else list(store.values())
    )
    out: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for person in entry.get("people") or []:
            label = person.get("label")
            if label and label not in out:
                out.append(label)
    return sorted(out)


def synced_at(connection_id: str) -> str | None:
    entry = _load().get(str(connection_id))
    return entry.get("synced_at") if isinstance(entry, dict) else None
