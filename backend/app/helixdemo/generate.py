"""Expanding a described scenario into plausible Helix events.

The model writes a *specification*, not the data. It says what a
point-of-sale transaction looks like -- what an item costs, how often a
discount is used, which products exist -- and this expands that into as
many rows as asked for.

Doing it the other way round, asking for the rows themselves, costs a
model call per batch, caps out at a few dozen before the response is
unwieldy, and produces rows that do not relate to one another. A total
that ignores the item count beside it, a discount code that appears on
every second sale. Incoherence is what makes invented data read as
invented, and it is exactly what a spec fixes: totals scale with counts,
codes appear at the rate the model said they should, and the same seed
gives the same demo twice.

Fields the model can ask for:

  choice        one of a weighted list
  id            a prefixed random number, e.g. TXN-481203
  int / money   a number in a range, optionally scaled by another field
  sample_from   several values drawn from a pool, count taken from a field
  text          one of a list of short phrases
  bool          "true" or "false" at a given rate, optionally condi-
                tional on another field
  ratio_of      a proportion of another number, bounded by it

Everything lands in Helix as a string, because every Helix attribute is
a string.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from typing import Any


# A batch is a demo, not a load test. Enough to make a timeline look
# lived-in, few enough to post without babysitting.
MAX_EVENTS = 500


def _weighted(rng: random.Random, values: list[Any], weights: list[float] | None):
    if not values:
        return ""
    if weights and len(weights) == len(values):
        return rng.choices(values, weights=weights, k=1)[0]
    return rng.choice(values)


def _money(value: float) -> str:
    return f"{value:.2f}"


# Helix truncates a value past this, so a longer one is not a richer
# demo -- it is a row that ends mid-word in Command.
MAX_VALUE_CHARS = 200


def _parse_clock(value: str) -> tuple[int, int] | None:
    """Read "7:58 AM" / "19:04" back into (hour, minute)."""
    for fmt in ("%I:%M %p", "%H:%M"):
        try:
            t = datetime.strptime(value.strip(), fmt)
            return t.hour, t.minute
        except ValueError:
            continue
    return None


def _one_field(
    rng: random.Random,
    spec: dict[str, Any],
    row: dict[str, Any],
    fields: dict[str, Any],
    when: datetime | None = None,
) -> str:
    kind = str(spec.get("kind") or "choice")

    # ---- Fields derived from the event's own timestamp ----
    #
    # A shift log has to agree with the timeline it sits on. If the day
    # and the clock-in are rolled independently, an event Helix stamps
    # 09:14 on a Tuesday carries attributes saying 4:30 PM on a Saturday,
    # and the demo falls apart the moment somebody clicks a row.
    #
    # Times render straight off ``when`` without a timezone shift, which
    # matches how ``build_times`` already treats hours as local.
    if kind in ("event_day", "event_time") and when is not None:
        if kind == "event_day":
            return when.strftime(str(spec.get("format") or "%A"))
        return when.strftime(str(spec.get("format") or "%-I:%M %p"))

    if kind == "time_after":
        # A clock time some hours after another one, for the end of a
        # shift or a visit. Wraps past midnight so a night shift reads
        # 11:12 PM -> 7:30 AM instead of running off the end of the day.
        base = _parse_clock(str(row.get(str(spec.get("of") or ""), "")))
        if base is None:
            return ""
        lo = float(spec.get("min_hours", 4))
        hi = float(spec.get("max_hours", 9))
        minutes = int(rng.uniform(min(lo, hi), max(lo, hi)) * 60)
        # Real shifts end on quarter hours far more often than at 6:43.
        minutes = int(round(minutes / 15.0)) * 15
        total = (base[0] * 60 + base[1] + minutes) % (24 * 60)
        stamp = datetime(2000, 1, 1, total // 60, total % 60)
        return stamp.strftime(str(spec.get("format") or "%-I:%M %p"))

    if kind == "choice":
        return str(_weighted(rng, spec.get("values") or [], spec.get("weights")))

    if kind == "bool":
        rate = float(spec.get("rate", 0.5))
        # An override keyed off another field. Without it a boolean can
        # only be independent of everything, and most real ones are not.
        when = spec.get("when")
        if isinstance(when, dict):
            driver = str(when.get("field") or "")
            wanted = when.get("in")
            actual = str(row.get(driver, ""))
            if isinstance(wanted, list) and actual in [str(w) for w in wanted]:
                rate = float(when.get("rate", rate))
        return "true" if rng.random() < rate else "false"

    if kind == "ratio_of":
        # A proportion of another number: a total after discount, a tax
        # line, a tip. Distinct from "scales_with", which spreads a
        # range across a driver — this one is bounded *by* the driver,
        # so a discounted total can never come out above the subtotal.
        driver = str(spec.get("of") or "")
        try:
            base = float(str(row.get(driver, "0")).replace(",", "").lstrip("$"))
        except ValueError:
            base = 0.0
        lo = float(spec.get("min_ratio", 0.8))
        hi = float(spec.get("max_ratio", 1.0))
        value = base * rng.uniform(min(lo, hi), max(lo, hi))
        return _money(value) if spec.get("money", True) else str(int(round(value)))

    if kind in ("int", "money"):
        low = float(spec.get("min", 0))
        high = float(spec.get("max", max(low, 1)))
        # "scales_with" is what makes a row hang together: a total that
        # tracks the number of items on it, rather than two numbers that
        # happen to share a row and contradict each other.
        driver = spec.get("scales_with")
        if driver and driver in row:
            try:
                factor = float(str(row[driver]).replace(",", ""))
            except ValueError:
                factor = 1.0
            # Per-unit comes from the driver's own ceiling: max total at
            # max quantity. Deriving it from a mid-range guess instead
            # made every basket over about eight items clamp to the
            # maximum, so a ten-item sale and a fourteen-item sale rang
            # up identical totals -- which is worse than random, because
            # it looks deliberate.
            driver_max = 0.0
            driver_spec = fields.get(driver)
            if isinstance(driver_spec, dict):
                try:
                    driver_max = float(driver_spec.get("max", 0) or 0)
                except (TypeError, ValueError):
                    driver_max = 0.0
            if driver_max <= 0:
                driver_max = float(spec.get("scale_base", 4) or 4)
            per = high / max(1.0, driver_max)
            value = per * factor * rng.uniform(0.78, 1.22)
            value = min(max(value, low), high)
        elif str(spec.get("skew")) == "low":
            # Most baskets are small. A flat distribution over 1..12 puts
            # as many twelve-item sales on the timeline as one-item ones,
            # which nobody's shop looks like.
            value = low + (high - low) * (rng.random() ** 2.2)
        else:
            value = rng.uniform(low, high)
        return _money(value) if kind == "money" else str(int(round(value)))

    if kind == "sample_from":
        pool = list(spec.get("pool") or [])
        if not pool:
            return ""
        count_from = spec.get("count_from")
        try:
            count = int(float(row.get(count_from, 0))) if count_from else 0
        except (TypeError, ValueError):
            count = 0
        if count <= 0:
            count = rng.randint(1, min(3, len(pool)))
        count = max(1, min(count, len(pool)))
        # Fill up to the character budget rather than to the count. A
        # fourteen-item basket is a real basket, but fourteen product
        # names is well past what Helix stores and what a row can show,
        # so the list is as long as it can be and then says how much it
        # left out.
        chosen = rng.sample(pool, count)
        out: list[str] = []
        used = 0
        for item in chosen:
            if used + len(item) + 2 > MAX_VALUE_CHARS - 12:
                break
            out.append(item)
            used += len(item) + 2
        text = ", ".join(out)
        remaining = count - len(out)
        if remaining > 0:
            text = f"{text} +{remaining} more"
        return text

    if kind == "id":
        # Transaction numbers, order refs, badge serials. Every real
        # system has one and none of the other kinds can make one: a
        # choice pool repeats, and a plain int reads as a quantity
        # rather than an identifier.
        prefix = str(spec.get("prefix") or "")
        digits = max(1, min(int(spec.get("digits", 6) or 6), 12))
        return f"{prefix}{rng.randrange(10 ** (digits - 1), 10**digits)}"

    if kind == "text":
        return str(_weighted(rng, spec.get("values") or [""], spec.get("weights")))

    return ""


def _order(fields: dict[str, Any]) -> list[str]:
    """Fields that others scale from, first.

    ``scales_with`` and ``count_from`` read a value that has to exist
    already, so anything depended upon is generated before its dependents.
    One pass is enough: the model is told not to write chains.
    """
    names = list(fields)
    depended: set[str] = set()
    for spec in fields.values():
        if not isinstance(spec, dict):
            continue
        depended.add(str(spec.get("scales_with") or ""))
        depended.add(str(spec.get("count_from") or ""))
        depended.add(str(spec.get("of") or ""))
        when = spec.get("when")
        if isinstance(when, dict):
            depended.add(str(when.get("field") or ""))
    depended.discard("")
    return sorted(names, key=lambda n: 0 if n in depended else 1)


def build_row(
    rng: random.Random,
    fields: dict[str, Any],
    when: datetime | None = None,
) -> dict[str, str]:
    row: dict[str, str] = {}
    # A caller with no timestamp still gets plausible times rather than
    # blanks. Blank attributes reach Helix looking like data that failed
    # to arrive, which is worse than an approximate clock-in.
    if when is None:
        when = datetime.now(timezone.utc)
    for name in _order(fields):
        spec = fields.get(name) or {}
        if not isinstance(spec, dict):
            continue
        # Truncated here as well as in the fields that know their own
        # budget: a model can put a 400-character phrase in a "text"
        # pool, and a value Helix cuts in half is worse than a short one.
        row[name] = _one_field(rng, spec, row, fields, when)[:MAX_VALUE_CHARS]
    return row


def build_times(
    rng: random.Random,
    count: int,
    timing: dict[str, Any],
    *,
    window_start: datetime,
    window_end: datetime,
    anchors: list[datetime] | None = None,
) -> list[datetime]:
    """When each event happened.

    Three shapes, because the right answer depends on what is being
    shown:

    * ``anchors`` -- real moments, from detections on the camera. The
      most convincing by a distance: a sale rung up at a second when
      somebody actually walked through the door, so clicking the event
      shows a person rather than an empty room.
    * ``business`` -- shaped by hour, with peaks. What a shop looks like.
    * anything else -- uniform. Honest, and obviously synthetic: a
      timeline with as much activity at 4am as at noon is the first
      thing that gives invented data away.
    """
    if anchors:
        pool = [t for t in anchors if window_start <= t <= window_end]
        if pool:
            if len(pool) >= count:
                return sorted(rng.sample(pool, count))
            # Fewer real moments than events wanted: use them all, and
            # scatter the rest within a couple of minutes of one, so the
            # extras still land near something that happened.
            out = list(pool)
            while len(out) < count:
                base = rng.choice(pool)
                out.append(base + timedelta(seconds=rng.randint(-120, 120)))
            return sorted(out)

    span = max(1.0, (window_end - window_start).total_seconds())
    if str(timing.get("shape")) == "business":
        open_h, close_h = timing.get("open_hours") or [9, 21]
        peaks = [int(h) for h in (timing.get("peaks") or [])]
        out: list[datetime] = []
        guard = 0
        while len(out) < count and guard < count * 60:
            guard += 1
            when = window_start + timedelta(seconds=rng.uniform(0, span))
            hour = when.hour
            if hour < int(open_h) or hour >= int(close_h):
                continue
            # Rejection sampling against an hourly weight: near a peak,
            # almost everything is kept; at the quiet end of the day most
            # candidates are thrown back.
            near = min((abs(hour - p) for p in peaks), default=99)
            keep = 1.0 if near <= 1 else 0.55 if near <= 3 else 0.28
            # Weekends are quieter unless the model said otherwise.
            if when.weekday() >= 5 and not timing.get("weekends", True):
                keep *= 0.3
            if rng.random() < keep:
                out.append(when)
        while len(out) < count:
            out.append(window_start + timedelta(seconds=rng.uniform(0, span)))
        return sorted(out)

    return sorted(
        window_start + timedelta(seconds=rng.uniform(0, span))
        for _ in range(count)
    )


def build_events(
    spec: dict[str, Any],
    *,
    count: int,
    window_days: int,
    seed: int | None = None,
    anchors: list[datetime] | None = None,
    timing_shape: str | None = None,
) -> list[dict[str, Any]]:
    """(attributes, when) for each event, ready to post."""
    rng = random.Random(seed)
    fields = spec.get("fields") if isinstance(spec.get("fields"), dict) else {}
    timing = dict(spec.get("timing") or {})
    if timing_shape:
        timing["shape"] = timing_shape

    count = max(1, min(int(count), MAX_EVENTS))
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=max(1, int(window_days)))
    times = build_times(
        rng, count, timing, window_start=start, window_end=now, anchors=anchors
    )
    return [
        {"attributes": build_row(rng, fields, when), "at": when}
        for when in times
    ]
