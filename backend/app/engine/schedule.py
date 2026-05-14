"""Schedule trigger evaluation.

Three preset kinds — kept narrow on purpose because a free-form cron
expression UI is its own rabbit hole and we don't need the flexibility
yet:

  - ``interval``: fires every N minutes (config: ``every_minutes``)
  - ``daily``:    fires once a day at HH:MM (config: ``hour`` 0-23,
                  ``minute`` 0-59)
  - ``weekly``:   like daily, plus ``weekday`` 0-6 (0=Monday, matching
                  ``datetime.weekday()``)

The worker tick calls :func:`is_due` once a minute for every enabled
schedule flow and enqueues a run if the answer is yes. We compare
against the flow's ``last_scheduled_at`` to make sure we don't double-
fire across ticks for daily/weekly windows.

All comparisons are in UTC. A future enhancement can let the user pick
a timezone in the trigger_config — for now, daily-at-06:00 means 06:00
UTC.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


def _coerce_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def is_due(
    config: dict[str, Any] | None,
    *,
    now: datetime,
    last: datetime | None,
) -> bool:
    """Decide whether a schedule-trigger flow should fire at ``now``.

    ``last`` is the flow's recorded ``last_scheduled_at`` (UTC, or None
    if it has never fired). The 1-minute tick window means daily /
    weekly schedules fire if and only if the current minute matches
    HH:MM and we haven't already fired in the last 23 hours."""
    if not isinstance(config, dict):
        return False
    kind = config.get("kind")
    now_utc = now.astimezone(timezone.utc)
    last_utc = last.astimezone(timezone.utc) if last is not None else None

    if kind == "interval":
        every = max(1, _coerce_int(config.get("every_minutes"), 0))
        if last_utc is None:
            return True
        return (now_utc - last_utc) >= timedelta(minutes=every)

    if kind == "daily":
        hour = _coerce_int(config.get("hour"), -1)
        minute = _coerce_int(config.get("minute"), -1)
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            return False
        if now_utc.hour != hour or now_utc.minute != minute:
            return False
        if last_utc is None:
            return True
        # Don't re-fire within the same day window.
        return (now_utc - last_utc) >= timedelta(hours=23)

    if kind == "weekly":
        hour = _coerce_int(config.get("hour"), -1)
        minute = _coerce_int(config.get("minute"), -1)
        weekday = _coerce_int(config.get("weekday"), -1)
        if not (
            0 <= hour <= 23
            and 0 <= minute <= 59
            and 0 <= weekday <= 6
        ):
            return False
        if now_utc.weekday() != weekday:
            return False
        if now_utc.hour != hour or now_utc.minute != minute:
            return False
        if last_utc is None:
            return True
        return (now_utc - last_utc) >= timedelta(days=6, hours=23)

    return False
