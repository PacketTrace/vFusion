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

# Raw results kept per server. At one check a minute this is the last
# ninety minutes -- enough to draw a recent strip, and no more, because
# a week of raw checks is ten thousand entries to answer a question
# ("what is the uptime") that two counters answer exactly.
MAX_CHECKS = 90

# Outages kept per server. Long enough to see a pattern, bounded so a
# flapping server cannot grow the file without limit.
MAX_OUTAGES = 20

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
        # Older files stored a bare list per url. Read them forward
        # rather than discarding the history somebody has been
        # accumulating.
        rec = data.get(url)
        if isinstance(rec, list):
            rec = {"checks": rec, "totals": {}, "outages": []}
        if not isinstance(rec, dict):
            rec = {"checks": [], "totals": {}, "outages": []}

        checks: list[dict[str, Any]] = list(rec.get("checks") or [])
        totals: dict[str, Any] = dict(rec.get("totals") or {})
        outages: list[dict[str, Any]] = list(rec.get("outages") or [])

        # Counters, not a count of what we kept. Uptime over three days
        # should not depend on how many raw rows the file happens to
        # hold, and trimming the window must not rewrite history.
        totals.setdefault("since", entry["at"])
        totals["ok"] = int(totals.get("ok") or 0) + (1 if ok else 0)
        totals["fail"] = int(totals.get("fail") or 0) + (0 if ok else 1)

        # An outage is a period, not a tally. One row per stretch of
        # failure, opened on the first and closed on recovery, which is
        # the shape of the question people actually ask: when was it
        # down, and for how long.
        was_ok = bool(checks[-1].get("ok")) if checks else True
        if not ok and was_ok:
            outages.append({"from": entry["at"], "to": None, "checks": 1})
        elif not ok and outages and outages[-1].get("to") is None:
            outages[-1]["checks"] = int(outages[-1].get("checks") or 0) + 1
        elif ok and outages and outages[-1].get("to") is None:
            outages[-1]["to"] = entry["at"]

        checks.append(entry)
        data[url] = {
            "checks": checks[-MAX_CHECKS:],
            "totals": totals,
            "outages": outages[-MAX_OUTAGES:],
        }
        _save(data)
        return summarize(data[url])


def summarize(rec: Any) -> dict[str, Any]:
    """What the page shows: is it up, how fast, and when was it not.

    Not "33 of 33 checks ok". That number was the size of the buffer as
    much as anything about the server, and it grew less meaningful the
    more often we checked. Uptime is a percentage over a stated period,
    and an outage is a time and a duration.
    """
    if isinstance(rec, list):  # pre-counters file
        rec = {"checks": rec, "totals": {}, "outages": []}
    if not isinstance(rec, dict):
        return {"checks": 0}

    checks: list[dict[str, Any]] = list(rec.get("checks") or [])
    totals: dict[str, Any] = dict(rec.get("totals") or {})
    outages: list[dict[str, Any]] = list(rec.get("outages") or [])
    if not checks:
        return {"checks": 0}

    last = checks[-1]
    scheduled = [c for c in checks if c.get("source") == "cron"]
    ok_total = int(totals.get("ok") or 0)
    fail_total = int(totals.get("fail") or 0)
    seen = ok_total + fail_total

    latencies = [
        int(c["timings"]["total_ms"])
        for c in checks
        if c.get("ok")
        and isinstance(c.get("timings"), dict)
        and c["timings"].get("total_ms")
    ]

    # Consecutive failures ending at the most recent check — the
    # difference between "it broke once last Tuesday" and "it is broken".
    failing_since: str | None = None
    streak = 0
    for c in reversed(checks):
        if c.get("ok"):
            break
        streak += 1
        failing_since = c.get("at")

    ongoing = [o for o in outages if o.get("to") is None]
    closed = [o for o in outages if o.get("to")]
    out: dict[str, Any] = {
        "checks": len(checks),
        "last_check_at": last.get("at"),
        "last_ok": bool(last.get("ok")),
        "last_source": last.get("source"),
        "last_error": last.get("error"),
        "last_scheduled_at": scheduled[-1].get("at") if scheduled else None,
        "failing_streak": streak,
        "failing_since": failing_since if streak else None,
        "last_timings": last.get("timings"),
        # Uptime across everything ever recorded, with the date it
        # started, so the number means something specific.
        "uptime_pct": round(100.0 * ok_total / seen, 2) if seen else None,
        "measuring_since": totals.get("since"),
        "outage_count": len(outages),
        "last_outage": (ongoing or closed or [None])[-1],
        # Newest last, so the UI draws it left-to-right without
        # reversing anything.
        "recent": [
            {
                "at": c.get("at"),
                "ok": bool(c.get("ok")),
                "total_ms": (c.get("timings") or {}).get("total_ms"),
            }
            for c in checks[-60:]
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
        return summarize(_load().get(url) or {})


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
