"""A record of every check-in with an MCP server, good or bad.

The MCP page could tell you what a server exposes but not whether that
picture was current, or whether the server had been answering reliably.
Those are different questions from "what changed": a catalog that has
not changed in a month looks identical whether the server is healthy and
stable or has been refusing connections since Tuesday.

So every poll writes an outcome here -- including the failures, which
are the entire point. A store that only recorded successes would show an
unbroken green history for a server that has been down for a week.

File-backed on the shared ``webhook_assets`` volume, same as the tool
history beside it. ``app_settings.value`` is varchar(255) and this is a
rolling window of check results, so it was never a candidate.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

HEALTH_PATH = Path(os.environ.get("MCP_HEALTH_FILE", "/app/data/mcp/health.json"))

# How many check results to keep per server. At hourly polling this is a
# little over three days -- long enough to show a pattern, short enough
# that the file stays small and the page can render every point.
MAX_CHECKS = 96

_lock = asyncio.Lock()


def _load() -> dict[str, list[dict[str, Any]]]:
    try:
        data = json.loads(HEALTH_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as e:
        # Derived data. A corrupt file should cost us the history, not
        # the page.
        logger.warning("MCP health log unreadable (%s); starting over", e)
        return {}


def _save(data: dict[str, Any]) -> None:
    try:
        HEALTH_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = HEALTH_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=0, sort_keys=True))
        tmp.replace(HEALTH_PATH)
    except OSError as e:
        logger.warning("could not persist MCP health: %s", e)


async def record(
    url: str,
    *,
    ok: bool,
    source: str,
    timings: dict[str, int] | None = None,
    protocol: str | None = None,
    requested_protocol: str | None = None,
    tool_count: int | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    """Append one check result and return the rolled-up health.

    ``source`` is "cron" or "page": a page view is a real check-in and
    worth keeping, but only the cron runs on a schedule, so freshness
    has to be able to tell them apart. A page-only history would claim
    the server was checked an hour ago when what happened an hour ago
    was somebody looking at it.
    """
    entry: dict[str, Any] = {
        "at": datetime.now(timezone.utc).isoformat(),
        "ok": ok,
        "source": source,
    }
    if timings:
        entry["timings"] = timings
    if protocol:
        entry["protocol"] = protocol
    if requested_protocol:
        entry["requested_protocol"] = requested_protocol
    if tool_count is not None:
        entry["tool_count"] = tool_count
    if error:
        # Bounded: a stack trace or an HTML error page would otherwise
        # be pasted into the log verbatim, ninety-six times over.
        entry["error"] = error[:300]

    async with _lock:
        data = _load()
        checks = data.get(url) or []
        checks.append(entry)
        data[url] = checks[-MAX_CHECKS:]
        _save(data)
        return summarize(data[url])


def summarize(checks: list[dict[str, Any]]) -> dict[str, Any]:
    """What the page shows: how fresh, how healthy, how fast."""
    if not checks:
        return {"checks": 0}

    last = checks[-1]
    scheduled = [c for c in checks if c.get("source") == "cron"]
    ok_checks = [c for c in checks if c.get("ok")]
    latencies = [
        int(c["timings"]["total_ms"])
        for c in ok_checks
        if isinstance(c.get("timings"), dict) and c["timings"].get("total_ms")
    ]

    # Consecutive failures ending at the most recent check. "3 of the
    # last 96 failed" reads very differently depending on whether they
    # were three months ago or are still happening.
    failing_since: str | None = None
    streak = 0
    for c in reversed(checks):
        if c.get("ok"):
            break
        streak += 1
        failing_since = c.get("at")

    out: dict[str, Any] = {
        "checks": len(checks),
        "last_check_at": last.get("at"),
        "last_ok": bool(last.get("ok")),
        "last_source": last.get("source"),
        "last_error": last.get("error"),
        "last_scheduled_at": scheduled[-1].get("at") if scheduled else None,
        "ok_count": len(ok_checks),
        "fail_count": len(checks) - len(ok_checks),
        "failing_streak": streak,
        "failing_since": failing_since if streak else None,
        "last_timings": last.get("timings"),
        # Newest last, so the UI can draw it left-to-right without
        # reversing anything.
        "recent": [
            {
                "at": c.get("at"),
                "ok": bool(c.get("ok")),
                "total_ms": (c.get("timings") or {}).get("total_ms"),
            }
            for c in checks[-24:]
        ],
    }
    if latencies:
        ordered = sorted(latencies)
        out["latency_ms"] = {
            "last": (last.get("timings") or {}).get("total_ms"),
            "median": ordered[len(ordered) // 2],
            "slowest": ordered[-1],
            "samples": len(ordered),
        }
    return out


async def read(url: str) -> dict[str, Any]:
    """Health for one server without recording a check."""
    async with _lock:
        return summarize(_load().get(url) or [])


class Timer:
    """Wall-clock for one phase of a check-in, in whole milliseconds.

    Monotonic: a check that straddles an NTP correction should not be
    able to report a negative handshake.
    """

    def __init__(self) -> None:
        self._marks: dict[str, int] = {}
        self._start = time.monotonic()
        self._phase = self._start

    def mark(self, name: str) -> None:
        now = time.monotonic()
        self._marks[name] = int((now - self._phase) * 1000)
        self._phase = now

    def finish(self) -> dict[str, int]:
        return {**self._marks, "total_ms": int((time.monotonic() - self._start) * 1000)}
