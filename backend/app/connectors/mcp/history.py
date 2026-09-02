"""When each MCP tool first showed up — kept in a file, not the database.

MCP publishes no timestamps: a ``tools/list`` entry carries only name,
description, inputSchema and annotations, and a server is free to report
its version as "dev". So "when was this tool added" and "when did this
server last change" can only be answered by looking repeatedly and
writing down what moved.

This lives as JSON on the ``webhook_assets`` volume (the same one holding
captured clips and frames) rather than in Postgres, so adding it costs
operators no schema migration. It's derived data — losing it means the
next fetch re-baselines, not that anything breaks.

Shape on disk:

    {"<server url>": {"<tool name>": {
        "first_seen": "<iso>", "last_seen": "<iso>", "baseline": bool,
        "hash": "<sha256>", "schema_changed_at": "<iso>|null",
        "removed_at": "<iso>|null"}}}
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

HISTORY_PATH = Path(
    os.environ.get("MCP_HISTORY_FILE", "/app/data/mcp/tool-history.json")
)

# Serializes read-modify-write across concurrent requests in this process.
_lock = asyncio.Lock()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _parse(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def tool_hash(tool: dict[str, Any]) -> str:
    """Fingerprint the parts of a tool an operator would call a change."""
    payload = json.dumps(
        {
            "description": tool.get("description"),
            "inputSchema": tool.get("inputSchema"),
            "annotations": tool.get("annotations"),
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _load() -> dict[str, dict[str, dict[str, Any]]]:
    try:
        return json.loads(HISTORY_PATH.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as e:
        # Derived data — a corrupt file shouldn't take the page down. Start
        # over rather than fail the request.
        logger.warning("MCP history unreadable (%s); re-baselining", e)
        return {}


def _save(data: dict[str, Any]) -> None:
    try:
        HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-rename so a crash mid-write can't leave a truncated
        # file behind.
        tmp = HISTORY_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=0, sort_keys=True))
        tmp.replace(HISTORY_PATH)
    except OSError as e:
        logger.warning("could not persist MCP history: %s", e)


async def record(url: str, tools: list[dict[str, Any]]) -> dict[str, Any]:
    """Diff this catalog against what we've seen before on this server.

    Annotates each tool dict in place with ``_is_baseline`` /
    ``_first_seen_at`` / ``_schema_changed_at``, and returns the
    server-level summary the UI shows.
    """
    async with _lock:
        store = _load()
        existing = store.get(url, {})
        now = datetime.now(timezone.utc)
        # Nothing on record means this is our first look: we can't date
        # anything already here, so it's all baseline.
        first_ever = not existing
        updated: dict[str, dict[str, Any]] = dict(existing)

        seen: set[str] = set()
        for tool in tools:
            name = tool.get("name")
            if not name:
                continue
            seen.add(name)
            digest = tool_hash(tool)
            prior = existing.get(name)
            if prior is None:
                updated[name] = {
                    "first_seen": _iso(now),
                    "last_seen": _iso(now),
                    "baseline": first_ever,
                    "hash": digest,
                    "schema_changed_at": None,
                    "removed_at": None,
                }
                continue
            entry = dict(prior)
            entry["last_seen"] = _iso(now)
            # A tool that vanished and came back isn't "new" — keep the
            # original first_seen and just clear the removal.
            entry["removed_at"] = None
            if entry.get("hash") != digest:
                entry["hash"] = digest
                entry["schema_changed_at"] = _iso(now)
            updated[name] = entry

        for name, entry in existing.items():
            if name not in seen and not entry.get("removed_at"):
                updated[name] = {**entry, "removed_at": _iso(now)}

        store[url] = updated
        _save(store)

    # "Last updated" means the server's surface actually moved — a tool
    # added, removed, or edited. Baseline arrivals don't count: those mark
    # when we started watching, not when the server shipped anything.
    changes: list[datetime] = []
    for entry in updated.values():
        if not entry.get("baseline"):
            if (d := _parse(entry.get("first_seen"))) is not None:
                changes.append(d)
        for key in ("schema_changed_at", "removed_at"):
            if (d := _parse(entry.get(key))) is not None:
                changes.append(d)

    cutoff = now - timedelta(days=30)
    new_30d = sum(
        1
        for e in updated.values()
        if not e.get("baseline")
        and not e.get("removed_at")
        and (d := _parse(e.get("first_seen"))) is not None
        and d >= cutoff
    )
    baseline_times = [
        d
        for e in updated.values()
        if e.get("baseline") and (d := _parse(e.get("first_seen"))) is not None
    ]

    for tool in tools:
        entry = updated.get(tool.get("name", ""))
        if not entry:
            continue
        tool["_is_baseline"] = bool(entry.get("baseline"))
        tool["_first_seen_at"] = entry.get("first_seen")
        tool["_schema_changed_at"] = entry.get("schema_changed_at")

    return {
        "history_since": _iso(min(baseline_times)) if baseline_times else None,
        "last_changed_at": _iso(max(changes)) if changes else None,
        "new_tools_30d": new_30d,
        "tracked_tools": len(updated),
    }
