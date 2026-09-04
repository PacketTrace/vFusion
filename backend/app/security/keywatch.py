"""Is vFusion's Verkada key being used by anyone but vFusion?

The premise is a key issued for vFusion and nothing else. That makes
the test an invariant rather than a guess: every call made with it
should come from vFusion's own egress IP, so a second IP is a second
holder.

Verkada's audit log cannot be filtered. ``GET /core/v1/audit_log``
takes a time range and pagination and nothing else -- no event type, no
key, no IP -- so the cost of asking is set by the org's event volume,
not by how narrow the question is. That single fact shapes everything
here: this walks forward from a stored cursor on a schedule and keeps
only aggregates, because sweeping on demand would mean re-reading a
day of events every time somebody opened a page.

Two details that are load-bearing rather than optional:

* The cursor uses ``use_processed_timestamp``. Events can finish
  processing after the window that contains them has closed, so a
  cursor on ``timestamp`` silently drops them -- and a dropped window
  is exactly the one an attacker would be in.
* vFusion learns its own IP from the log rather than from an external
  "what is my IP" service. The log reports the address *Verkada saw*,
  which is the only one that matters, and needs no third party. Audit
  reads are not themselves audited, so a heartbeat call is issued each
  cycle to guarantee there is something of ours in the window.

Aggregates only. Storing raw audit rows would be tens of thousands of
rows a day of activity metadata -- expensive, and far more sensitive
than the question being asked.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.client import VerkadaClient
from app.crypto import decrypt_secret
from app.models import Connection
from app.settings_store import get_str, invalidate_cache, set_value


logger = logging.getLogger(__name__)

AUDIT_PATH = "/core/v1/audit_log"
# A cheap GET that exists in every org, used to put a known-ours entry
# in the window. Audit reads do not appear in the audit log, so without
# this an idle install never learns its own address.
HEARTBEAT_PATH = "/cameras/v1/devices"

ENABLED_KEY = "keywatch_enabled"
CONNECTION_KEY = "keywatch_connection_id"
INTERVAL_KEY = "keywatch_interval_hours"
STATE_KEY = "keywatch_state"

DEFAULT_INTERVAL_HOURS = 1

# Pages are 200 events. This bounds one cycle's cost on a very busy org
# rather than letting a backlog turn into an unbounded request storm --
# whatever is left is picked up next cycle, because the cursor only
# advances over what was actually read.
MAX_PAGES = 50
PAGE_SIZE = 200

# A wall-clock ceiling, separate from the page cap. A browser waiting on
# a request has no way to distinguish "still working" from "dead", so an
# interactive check returns partial results rather than being right
# eventually. The cursor only advances over what was actually read, so a
# short cycle costs nothing but a later catch-up.
INTERACTIVE_BUDGET_SEC = 20.0
CRON_BUDGET_SEC = 240.0

# Never reach back further than this on a first run or after a long
# outage. Without it, a cursor that is weeks stale would try to read
# every event since then in one go.
MAX_LOOKBACK_SEC = 6 * 3600


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _visible_tail(masked: str) -> str:
    """The unmasked end of ``**********************ABcd==``.

    Verkada masks the key in the log but leaves a stable tail, which is
    enough to tell our key's entries from another key's without the
    plaintext ever entering the comparison.
    """
    if not masked:
        return ""
    return masked.rsplit("*", 1)[-1] if "*" in masked else masked


def _is_ours(masked: str, api_key: str) -> bool:
    tail = _visible_tail(masked)
    # Four characters would collide by chance across enough keys; the
    # real masks leave six or more.
    return len(tail) >= 5 and api_key.endswith(tail)


def blank_state() -> dict[str, Any]:
    return {
        "cursor": 0,
        "expected_ips": [],
        "self_ip": None,
        "observed": {},
        "alerts": [],
        "denied_count": 0,
        "denied_last": None,
        "last_check": None,
        "last_success": None,
        "last_error": None,
        "events_seen": 0,
        "requests_used": 0,
        "coverage_gap": None,
    }


async def load_state() -> dict[str, Any]:
    raw = await get_str(STATE_KEY)
    if not raw:
        return blank_state()
    try:
        state = json.loads(raw)
    except (ValueError, TypeError):
        return blank_state()
    if not isinstance(state, dict):
        return blank_state()
    base = blank_state()
    base.update(state)
    return base


async def save_state(session: AsyncSession, state: dict[str, Any]) -> None:
    await set_value(session, STATE_KEY, json.dumps(state, separators=(",", ":")))
    # The settings cache is 30s; without this a "check now" followed by a
    # page load would render the state from before the check.
    invalidate_cache()


async def _fetch_window(
    client: VerkadaClient, start: int, end: int, budget_sec: float
) -> tuple[list[dict[str, Any]], int, bool, int]:
    """Every audit row between two epoch seconds.

    Returns (rows, requests, stopped early, last timestamp reached).

    Stopping early leaves a hole. Pages arrive newest-first, so a
    truncated read has the recent end of the window and is missing the
    older part -- and the cursor still has to advance, because falling
    behind permanently is worse than one gap. The gap is therefore
    recorded and shown rather than swallowed: a monitor that quietly
    skipped an hour is exactly the hour worth knowing about.
    """
    rows: list[dict[str, Any]] = []
    token: str | None = None
    seen_tokens: set[str] = set()
    requests = 0
    deadline = time.monotonic() + budget_sec
    for page in range(MAX_PAGES):
        if time.monotonic() > deadline:
            logger.warning(
                "keywatch: stopping at page %s — %.0fs budget spent, %s rows so far",
                page,
                budget_sec,
                len(rows),
            )
            return rows, requests, True, 0
        query: dict[str, Any] = {
            "start_time": start,
            "end_time": end,
            "page_size": PAGE_SIZE,
            # Not optional. See the module docstring.
            "use_processed_timestamp": "true",
        }
        if token:
            query["page_token"] = token
        result = await client.request(method="GET", path=AUDIT_PATH, query=query)
        requests += 1
        code = int(result.get("status_code") or 500)
        if code >= 400:
            raise RuntimeError(f"audit log returned {code}: {result.get('body')!r}")
        body = result.get("body")
        if not isinstance(body, dict):
            raise RuntimeError("audit log returned an unexpected body")
        page = body.get("audit_logs")
        rows.extend(r for r in (page or []) if isinstance(r, dict))
        logger.warning(
            "keywatch: page %s -> %s rows (%s total)", page, len(page or []), len(rows)
        )
        token = body.get("next_page_token") or None
        # Three ways to be done. A page shorter than the size asked for
        # is the end of the data; a repeated token means the API is not
        # advancing and looping on it would burn the whole page budget
        # re-reading one page.
        if not token or len(page or []) < PAGE_SIZE or token in seen_tokens:
            return rows, requests, False, 0
        seen_tokens.add(token)
    return rows, requests, True, 0


async def run_check(
    session: AsyncSession, budget_sec: float = CRON_BUDGET_SEC
) -> dict[str, Any]:
    """One polling cycle. Returns the updated state.

    Never raises: a monitor whose failures are exceptions somewhere in a
    cron log is a monitor that shows green forever. Failures land in
    ``last_error`` where the page can render them.
    """
    state = await load_state()
    state["last_check"] = _now().isoformat()

    conn_id = await get_str(CONNECTION_KEY)
    if not conn_id:
        state["last_error"] = "No Verkada connection selected to watch."
        await save_state(session, state)
        return state

    try:
        conn = await session.get(Connection, UUID(conn_id))
    except (ValueError, TypeError):
        conn = None
    if conn is None or conn.type != "verkada":
        state["last_error"] = "The watched connection no longer exists."
        await save_state(session, state)
        return state

    try:
        secret = decrypt_secret(conn.encrypted_secret) or {}
    except ValueError as e:
        state["last_error"] = f"Could not read that connection's key: {e}"
        await save_state(session, state)
        return state
    api_key = secret.get("api_key") or ""
    if not api_key:
        state["last_error"] = "That connection has no API key."
        await save_state(session, state)
        return state

    try:
        client = VerkadaClient(api_key=api_key, base_url=secret.get("region") or None)
    except Exception as e:  # noqa: BLE001
        state["last_error"] = f"Could not build a Verkada client: {e}"
        await save_state(session, state)
        return state

    now_s = int(_now().timestamp())
    cursor = int(state.get("cursor") or 0)
    start = max(cursor, now_s - MAX_LOOKBACK_SEC) if cursor else now_s - 3600

    requests_used = 0
    # Heartbeat first, so there is something of ours in the *next*
    # window even if nothing else touched Verkada this hour. Its own
    # entry usually lands a cycle later, which is why self_ip is allowed
    # to be a cycle stale.
    try:
        await client.request(method="GET", path=HEARTBEAT_PATH, query={"page_size": 1})
        requests_used += 1
    except Exception as e:  # noqa: BLE001 — a failed heartbeat is not fatal
        logger.info("keywatch heartbeat failed: %s", e)

    try:
        logger.warning(
            "keywatch: scanning %s..%s (%ss) with a %.0fs budget",
            start,
            now_s,
            now_s - start,
            budget_sec,
        )
        rows, used, truncated, _ = await _fetch_window(
            client, start, now_s, budget_sec
        )
        requests_used += used
        logger.warning(
            "keywatch: read %s rows in %s request(s), truncated=%s",
            len(rows),
            used,
            truncated,
        )
    except Exception as e:  # noqa: BLE001
        state["last_error"] = str(e)
        state["requests_used"] = requests_used
        await save_state(session, state)
        return state

    observed: dict[str, Any] = dict(state.get("observed") or {})
    ours = 0
    denied = 0
    denied_last = state.get("denied_last")
    self_ip = state.get("self_ip")

    for row in rows:
        details = row.get("details")
        if not isinstance(details, dict):
            continue
        if not _is_ours(str(details.get("api_key") or ""), api_key):
            continue
        ip = str(row.get("ip_address") or "").strip()
        if not ip:
            continue
        ours += 1
        stamp = str(row.get("timestamp") or "")
        entry = observed.get(ip) or {"first": stamp, "last": stamp, "count": 0, "urls": []}
        entry["count"] = int(entry.get("count") or 0) + 1
        if stamp:
            if not entry.get("first") or stamp < entry["first"]:
                entry["first"] = stamp
            if not entry.get("last") or stamp > entry["last"]:
                entry["last"] = stamp
        url = str(details.get("url") or "")
        urls = entry.get("urls") or []
        # A handful of examples is enough to recognise what something
        # was doing; the full list would grow without bound.
        if url and url not in urls and len(urls) < 6:
            urls.append(url)
        entry["urls"] = urls
        observed[ip] = entry

        try:
            code = int(details.get("response_status_code") or 0)
        except (TypeError, ValueError):
            code = 0
        if code in (401, 403):
            denied += 1
            denied_last = stamp or denied_last

        # The heartbeat identifies us. Any call from the address that
        # made it is ours by definition.
        if url.startswith(HEARTBEAT_PATH):
            self_ip = ip

    expected = list(state.get("expected_ips") or [])
    if self_ip and not expected:
        # First successful cycle seeds the baseline silently. Alerting on
        # the install's own address would make the feature useless on the
        # day it was switched on.
        expected = [self_ip]
    if self_ip and self_ip not in expected:
        expected.append(self_ip)

    alerts = list(state.get("alerts") or [])
    known_alert_ips = {a.get("ip") for a in alerts}
    for ip, entry in observed.items():
        if ip in expected or ip in known_alert_ips:
            continue
        alerts.append(
            {
                "ip": ip,
                "first_seen": entry.get("first"),
                "last_seen": entry.get("last"),
                "count": entry.get("count", 0),
                "urls": entry.get("urls", []),
                "raised_at": _now().isoformat(),
            }
        )

    state.update(
        {
            "cursor": now_s,
            "expected_ips": expected,
            "self_ip": self_ip,
            "observed": observed,
            "alerts": alerts,
            "denied_count": int(state.get("denied_count") or 0) + denied,
            "denied_last": denied_last,
            "last_error": None,
            "last_success": _now().isoformat(),
            "events_seen": ours,
            "scanned_rows": len(rows),
            "requests_used": requests_used,
            "truncated": truncated,
            # Named, not implied. If this is set, some of the window was
            # never looked at.
            "coverage_gap": (
                {
                    "from": start,
                    "to": now_s,
                    "note": "Hit the time budget before reading the whole window.",
                }
                if truncated
                else None
            ),
        }
    )
    await save_state(session, state)
    return state


async def is_enabled() -> bool:
    return (await get_str(ENABLED_KEY)) == "1"


async def interval_hours() -> int:
    raw = await get_str(INTERVAL_KEY)
    try:
        return max(1, int(raw)) if raw else DEFAULT_INTERVAL_HOURS
    except (TypeError, ValueError):
        return DEFAULT_INTERVAL_HOURS
