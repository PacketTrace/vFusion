"""Copy the Command audit log into ``audit_events``, ten seconds at a time.

Why copy at all: ``GET /core/v1/audit_log`` takes a time range and
pagination and nothing else. Every filter the Explorer offers -- user,
event, device, IP, key, status -- would otherwise mean re-reading the
whole window on every keystroke. So the worker walks forward on a
cursor and lands rows locally; the page only ever reads Postgres.

Two cursors, one table:

* **Forward.** Every tick reads ``[cursor - overlap, now]`` filtered on
  ``processed_timestamp`` (not ``timestamp``: entries can finish
  processing after the window that contains them has closed, and a
  cursor on event time silently drops those). The overlap plus the
  fingerprint unique index is what makes re-reading safe.
* **Backlog.** A list of windows still owed: the initial backfill
  (seven days, in one-hour slices, newest first so the recent past
  fills in first), plus any forward tick that hit its page cap and had
  to leave the older part of its window behind. Each tick drains a
  bounded number of pages from it. A gap is therefore something that
  gets fetched later, not something that gets lost.

State is a JSON file per connection on the shared assets volume, like
keywatch and the virtual camera: ``app_settings.value`` is 255 chars
and this outgrows it on day one.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.taxonomy import actor_kind, categorize
from app.connectors.verkada.client import VerkadaClient
from app.crypto import decrypt_secret
from app.db import SessionLocal
from app.models import AuditEvent, Connection

logger = logging.getLogger(__name__)

AUDIT_PATH = "/core/v1/audit_log"
PAGE_SIZE = 200

STATE_DIR = Path(os.environ.get("AUDIT_STATE_DIR", "/app/data/audit"))

# How far a fresh install reaches back before it starts walking forward.
INITIAL_BACKFILL_DAYS = 7
BACKFILL_SLICE_SEC = 3600
# Re-read this much of the previous window every tick. Fingerprints
# make it free; it catches entries whose processed time landed exactly
# on the boundary.
OVERLAP_SEC = 30
# A forward tick on a busy org: 5 pages is 1,000 entries in ten
# seconds. Anything beyond that becomes a backlog window.
FORWARD_MAX_PAGES = 5
BACKLOG_PAGES_PER_TICK = 6
TICK_BUDGET_SEC = 8.0
MAX_ERROR_CHARS = 400
MAX_GAPS_KEPT = 50

_state_locks: dict[str, asyncio.Lock] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---- state ---------------------------------------------------------------


def blank_state() -> dict[str, Any]:
    return {
        "cursor": None,
        "backlog": [],
        "backfilled_from": None,
        "backfill_total_sec": 0,
        "backfill_done_sec": 0,
        "last_poll_at": None,
        "last_ok_at": None,
        "last_error": None,
        "last_rows": 0,
        "last_inserted": 0,
        "polls": 0,
        "requests": 0,
        "inserted": 0,
        "gaps": [],
    }


def _state_path(conn_id: UUID) -> Path:
    return STATE_DIR / f"{conn_id}.json"


def _lock_for(conn_id: UUID) -> asyncio.Lock:
    key = str(conn_id)
    if key not in _state_locks:
        _state_locks[key] = asyncio.Lock()
    return _state_locks[key]


async def load_state(conn_id: UUID) -> dict[str, Any]:
    async with _lock_for(conn_id):
        try:
            raw = _state_path(conn_id).read_text(encoding="utf-8")
        except OSError:
            return blank_state()
    try:
        state = json.loads(raw)
    except (ValueError, TypeError):
        return blank_state()
    base = blank_state()
    if isinstance(state, dict):
        base.update(state)
    return base


async def save_state(conn_id: UUID, state: dict[str, Any]) -> None:
    err = state.get("last_error")
    if isinstance(err, str) and len(err) > MAX_ERROR_CHARS:
        state["last_error"] = err[:MAX_ERROR_CHARS] + "…"
    state["gaps"] = (state.get("gaps") or [])[-MAX_GAPS_KEPT:]
    try:
        async with _lock_for(conn_id):
            path = _state_path(conn_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
            tmp.replace(path)
    except OSError:
        logger.warning("could not persist audit poll state", exc_info=True)


# ---- normalising one entry ----------------------------------------------


def _parse_ts(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            try:
                return datetime.fromtimestamp(float(s), tz=timezone.utc)
            except ValueError:
                return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


def visible_tail(masked: str | None) -> str:
    """The unmasked end of ``**********************ABcd==``. Verkada masks
    the key in the log but leaves a stable tail -- enough to recognise
    our own key without the plaintext entering the comparison."""
    if not masked:
        return ""
    return masked.rsplit("*", 1)[-1] if "*" in masked else masked


def _fingerprint(entry: dict[str, Any]) -> str:
    devices = entry.get("devices") or []
    device_ids = sorted(
        str(d.get("device_id") or "") for d in devices if isinstance(d, dict)
    )
    material = [
        str(entry.get("timestamp") or ""),
        str(entry.get("event_name") or ""),
        str(entry.get("user_id") or ""),
        str(entry.get("ip_address") or ""),
        entry.get("details") or {},
        device_ids,
    ]
    blob = json.dumps(material, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _strings_in(value: Any, out: list[str], budget: int = 60) -> None:
    if len(out) >= budget:
        return
    if isinstance(value, str):
        if value and not value.startswith("****"):
            out.append(value)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        out.append(str(value))
    elif isinstance(value, dict):
        for v in value.values():
            _strings_in(v, out, budget)
    elif isinstance(value, list):
        for v in value:
            _strings_in(v, out, budget)


_PLACEHOLDERS = ("-", "unknown", "unknown user", "unknown user name", "unknown user email", "n/a", "none", "null")


def _real_or_blank(value: Any) -> str:
    s = str(value or "").strip()
    return "" if s.casefold() in _PLACEHOLDERS or s.casefold().startswith("unknown user") else s


def _clip(value: Any, n: int) -> str | None:
    if value in (None, ""):
        return None
    s = str(value)
    return s[:n]


def normalize(
    entry: dict[str, Any], connection_id: UUID | None, own_keys: list[str]
) -> dict[str, Any] | None:
    ts = _parse_ts(entry.get("timestamp"))
    if ts is None:
        return None
    details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
    devices = [d for d in (entry.get("devices") or []) if isinstance(d, dict)]
    first = devices[0] if devices else {}
    name = (entry.get("event_name") or "").strip() or "Unknown event"

    masked = details.get("api_key") if isinstance(details.get("api_key"), str) else None
    tail = visible_tail(masked)
    is_self = len(tail) >= 5 and any(k.endswith(tail) for k in own_keys)

    status = details.get("response_status_code")
    try:
        status_code = int(status) if status not in (None, "") else None
    except (TypeError, ValueError):
        status_code = None
    size = details.get("response_content_size")
    try:
        response_size = int(size) if size not in (None, "") else None
    except (TypeError, ValueError):
        response_size = None

    # Verkada fills the user fields with literal placeholders on rows that
    # have no user -- "unknown user name", "unknown user email", "-" --
    # which would otherwise become a "user" with 28 events.
    user_name = _real_or_blank(entry.get("user_name"))
    user_email = _real_or_blank(entry.get("user_email"))
    user_id = (entry.get("user_id") or "").strip()
    if user_id == "00000000-0000-0000-0000-000000000000":
        user_id = ""

    parts: list[str] = [
        name,
        entry.get("event_description") or "",
        user_name,
        user_email,
        entry.get("ip_address") or "",
        details.get("api_key_name") or "",
        details.get("method") or "",
        details.get("url") or "",
        str(status_code or ""),
    ]
    for d in devices:
        parts += [
            d.get("device_name") or "",
            d.get("device_type") or "",
            d.get("device_site_name") or "",
        ]
        dd = d.get("details")
        if isinstance(dd, dict):
            parts.append(dd.get("serial_number") or "")
    extra: list[str] = []
    _strings_in(details, extra)
    parts += extra
    search_text = " ".join(p for p in parts if p).lower()[:4000]

    return {
        "fingerprint": _fingerprint(entry),
        "connection_id": connection_id,
        "org_id": _clip(entry.get("organization_id"), 64),
        "timestamp": ts,
        "processed_at": _parse_ts(entry.get("processed_timestamp")),
        "event_name": name[:128],
        "event_description": _clip(entry.get("event_description"), 512),
        "category": categorize(name),
        "actor": actor_kind(entry),
        "user_id": user_id[:64] or None,
        "user_name": user_name[:255] or None,
        "user_email": user_email[:255].lower() or None,
        "ip_address": _clip(entry.get("ip_address"), 64),
        "api_key_name": _clip(details.get("api_key_name"), 255),
        "api_key_tail": tail[:16] or None,
        "method": _clip(details.get("method"), 10),
        "url_path": _clip(details.get("url"), 1024),
        "status_code": status_code,
        "response_size": response_size,
        "is_self": is_self,
        "device_id": _clip(first.get("device_id"), 64),
        "device_name": _clip(first.get("device_name"), 255),
        "device_type": _clip(first.get("device_type"), 64),
        "device_site": _clip(first.get("device_site_name"), 255),
        "device_count": len(devices),
        "devices": devices,
        "details": details,
        "raw": entry,
        "search_text": search_text,
    }


async def upsert_rows(session: AsyncSession, rows: list[dict[str, Any]]) -> list[str]:
    """Insert what is new, skip what is already there. Returns the
    fingerprints that were actually inserted."""
    inserted: list[str] = []
    seen: set[str] = set()
    batch: list[dict[str, Any]] = []
    for row in rows:
        fp = row["fingerprint"]
        if fp in seen:
            continue
        seen.add(fp)
        batch.append(row)
    for i in range(0, len(batch), 500):
        chunk = batch[i : i + 500]
        stmt = (
            pg_insert(AuditEvent)
            .values(chunk)
            .on_conflict_do_nothing(index_elements=["fingerprint"])
            .returning(AuditEvent.fingerprint)
        )
        result = await session.execute(stmt)
        inserted.extend(str(r[0]) for r in result.fetchall())
    return inserted


# ---- flows ----------------------------------------------------------------

PAYLOAD_TOP = (
    "timestamp", "event_name", "event_description", "category", "actor",
    "user_id", "user_name", "user_email", "ip_address", "api_key_name",
    "method", "url_path", "status_code", "is_self", "org_id",
)


def trigger_payload(row: dict[str, Any] | AuditEvent, row_id: Any = None) -> dict[str, Any]:
    """What a flow sees as ``trigger`` when an audit row starts it.

    Who / when / what at the top level; the *target* -- the device and
    Verkada's ``details`` -- under ``data``, which is where webhook flows
    already look, so ``{{ trigger.data.camera_id }}`` keeps meaning the
    same thing whichever trigger started the flow.
    """
    get = (lambda k: row.get(k)) if isinstance(row, dict) else (lambda k: getattr(row, k, None))
    out: dict[str, Any] = {"audit": True, "id": str(row_id or get("id") or "")}
    for k in PAYLOAD_TOP:
        v = get(k)
        out[k] = v.isoformat() if isinstance(v, datetime) else v
    devices = get("devices") or []
    details = get("details") or {}
    data: dict[str, Any] = dict(details) if isinstance(details, dict) else {}
    data.update(
        {
            "device_id": get("device_id"),
            "device_name": get("device_name"),
            "device_type": get("device_type"),
            "device_site": get("device_site"),
        }
    )
    if (get("device_type") or "").lower() == "camera" and get("device_id"):
        data["camera_id"] = get("device_id")
    out["data"] = data
    out["devices"] = devices
    return out


async def dispatch_flows(rows: list[dict[str, Any]], pool: Any) -> int:
    """Start every enabled ``verkada_audit`` flow whose trigger matches
    one of these freshly inserted rows. Mirrors the webhook ingest path
    so the run engine does not know audit rows exist."""
    if not rows:
        return 0
    from app.engine.triggers import matches_audit
    from app.models import Flow, Run

    fired = 0
    async with SessionLocal() as session:
        flows = (
            await session.execute(
                select(Flow).where(Flow.enabled.is_(True), Flow.trigger_type == "verkada_audit")
            )
        ).scalars().all()
        if not flows:
            return 0
        ids = {
            fp: rid
            for fp, rid in (
                await session.execute(
                    select(AuditEvent.fingerprint, AuditEvent.id).where(
                        AuditEvent.fingerprint.in_([r["fingerprint"] for r in rows])
                    )
                )
            ).all()
        }
        pending: list[Run] = []
        for row in rows:
            payload = trigger_payload(row, ids.get(row["fingerprint"]))
            for flow in flows:
                if not matches_audit(flow.trigger_config or {}, payload):
                    continue
                run = Run(flow_id=flow.id, webhook_event_id=None, status="pending", input=payload)
                session.add(run)
                pending.append(run)
        if not pending:
            return 0
        await session.commit()
        for run in pending:
            if pool is not None:
                await pool.enqueue_job("run_flow", str(run.id))
            fired += 1
    if fired:
        logger.info("audit: started %d flow run(s)", fired)
    return fired


async def scrub_placeholder_users() -> None:
    """One-shot repair for rows stored before placeholder user strings
    were recognised. Idempotent and cheap once clean."""
    from sqlalchemy import update

    async with SessionLocal() as session:
        for col in (AuditEvent.user_name, AuditEvent.user_email):
            await session.execute(
                update(AuditEvent).where(col.ilike("unknown user%")).values({col.key: None})
            )
        await session.commit()


# ---- talking to Verkada ---------------------------------------------------


async def fetch_window(
    client: VerkadaClient,
    start: int,
    end: int,
    *,
    processed: bool,
    max_pages: int,
    deadline: float,
) -> tuple[list[dict[str, Any]], int, bool, int | None]:
    """Every entry between two epoch seconds, newest first.

    Returns (entries, requests made, stopped early, oldest timestamp
    reached). When it stops early the caller owes ``[start, oldest)``.
    """
    entries: list[dict[str, Any]] = []
    token: str | None = None
    seen_tokens: set[str] = set()
    requests = 0
    oldest: int | None = None
    ts_key = "processed_timestamp" if processed else "timestamp"
    for _ in range(max_pages):
        if time.monotonic() > deadline:
            return entries, requests, True, oldest
        query: dict[str, Any] = {
            "start_time": start,
            "end_time": end,
            "page_size": PAGE_SIZE,
        }
        if processed:
            query["use_processed_timestamp"] = "true"
        if token:
            query["page_token"] = token
        result = await client.request(method="GET", path=AUDIT_PATH, query=query)
        requests += 1
        code = int(result.get("status_code") or 500)
        if code >= 400:
            body = result.get("body")
            raise RuntimeError(f"audit log returned {code}: {str(body)[:200]}")
        body = result.get("body")
        if not isinstance(body, dict):
            raise RuntimeError("audit log returned an unexpected body")
        page = [e for e in (body.get("audit_logs") or []) if isinstance(e, dict)]
        entries.extend(page)
        for e in page:
            dt = _parse_ts(e.get(ts_key)) or _parse_ts(e.get("timestamp"))
            if dt is not None:
                sec = int(dt.timestamp())
                oldest = sec if oldest is None else min(oldest, sec)
        token = body.get("next_page_token") or None
        if not token or len(page) < PAGE_SIZE or token in seen_tokens:
            return entries, requests, False, oldest
        seen_tokens.add(token)
    return entries, requests, True, oldest


# ---- connections ----------------------------------------------------------


async def _verkada_connections(session: AsyncSession) -> list[tuple[Connection, str, str | None]]:
    conns = (
        await session.execute(select(Connection).where(Connection.type == "verkada"))
    ).scalars().all()
    out: list[tuple[Connection, str, str | None]] = []
    for conn in conns:
        try:
            secret = decrypt_secret(conn.encrypted_secret) or {}
        except ValueError:
            continue
        key = secret.get("api_key") or ""
        if key:
            out.append((conn, key, secret.get("region") or None))
    return out


def _slice(start: int, end: int, mode: str) -> list[list[Any]]:
    """Newest-first hourly windows covering [start, end)."""
    out: list[list[Any]] = []
    hi = end
    while hi > start:
        lo = max(start, hi - BACKFILL_SLICE_SEC)
        out.append([lo, hi, mode])
        hi = lo
    return out


def _ensure_backfill(state: dict[str, Any], now: int, days: int) -> None:
    """Queue a backfill reaching ``days`` back, without re-queuing time
    already covered. Idempotent."""
    target = now - days * 86400
    covered_from = state.get("backfilled_from")
    if covered_from is None:
        windows = _slice(target, now, "event")
        state["backfilled_from"] = target
    elif target < covered_from:
        windows = _slice(target, int(covered_from), "event")
        state["backfilled_from"] = target
    else:
        return
    # Newest first: put the fresh windows where the drain reads from.
    state["backlog"] = windows + list(state.get("backlog") or [])
    state["backfill_total_sec"] = int(state.get("backfill_total_sec") or 0) + sum(
        int(w[1]) - int(w[0]) for w in windows
    )


# ---- one tick -------------------------------------------------------------


async def tick_connection(
    conn: Connection, api_key: str, region: str | None, own_keys: list[str],
    *, budget_sec: float = TICK_BUDGET_SEC, pool: Any = None,
) -> dict[str, Any]:
    """One ten-second cycle for one connection. Never raises."""
    state = await load_state(conn.id)
    now = int(time.time())
    deadline = time.monotonic() + budget_sec
    state["last_poll_at"] = _now().isoformat()
    state["polls"] = int(state.get("polls") or 0) + 1
    requests = 0
    rows: list[dict[str, Any]] = []

    try:
        client = VerkadaClient(api_key=api_key, base_url=region)
    except Exception as e:  # noqa: BLE001
        state["last_error"] = f"Could not build a Verkada client: {e}"
        await save_state(conn.id, state)
        return state

    try:
        # First run: start the forward cursor a minute back and owe the
        # rest as a backfill.
        if state.get("cursor") is None:
            state["cursor"] = now - 60
            _ensure_backfill(state, now, INITIAL_BACKFILL_DAYS)

        # Forward.
        cursor = int(state["cursor"])
        start = max(0, cursor - OVERLAP_SEC)
        entries, n, truncated, oldest = await fetch_window(
            client, start, now, processed=True, max_pages=FORWARD_MAX_PAGES, deadline=deadline,
        )
        requests += n
        rows.extend(entries)
        # Only rows the forward poll found are "happening now". Backlog
        # windows are history, and history must not start flows.
        live_fps = {_fingerprint(e) for e in entries}
        if truncated and oldest is not None and oldest > start:
            # Newest-first pages: we have [oldest, now], we owe [start, oldest).
            state["backlog"] = [[start, oldest, "processed"]] + list(state.get("backlog") or [])
            state["gaps"] = (state.get("gaps") or []) + [[start, oldest, "deferred"]]
        state["cursor"] = now

        # Backlog.
        pages_left = BACKLOG_PAGES_PER_TICK
        backlog: list[list[Any]] = list(state.get("backlog") or [])
        while backlog and pages_left > 0 and time.monotonic() < deadline:
            lo, hi, mode = int(backlog[0][0]), int(backlog[0][1]), str(backlog[0][2])
            entries, n, truncated, oldest = await fetch_window(
                client, lo, hi, processed=(mode == "processed"),
                max_pages=pages_left, deadline=deadline,
            )
            requests += n
            pages_left -= n
            rows.extend(entries)
            if truncated and oldest is not None and lo < oldest < hi:
                backlog[0] = [lo, oldest, mode]
                covered = hi - oldest
            elif truncated:
                # Ran out of budget before a page came back, or the page
                # had no usable timestamps. Try the same window next tick.
                break
            else:
                backlog.pop(0)
                covered = hi - lo
            if mode == "event":
                state["backfill_done_sec"] = int(state.get("backfill_done_sec") or 0) + covered
        state["backlog"] = backlog

        inserted = 0
        if rows:
            normalized = [
                r for r in (normalize(e, conn.id, own_keys) for e in rows) if r is not None
            ]
            async with SessionLocal() as session:
                new_fps = set(await upsert_rows(session, normalized))
                await session.commit()
            inserted = len(new_fps)
            live_new = [r for r in normalized if r["fingerprint"] in new_fps and r["fingerprint"] in live_fps]
            if live_new:
                try:
                    state["flows_fired"] = int(state.get("flows_fired") or 0) + await dispatch_flows(live_new, pool)
                except Exception as e:  # noqa: BLE001
                    logger.warning("audit flow dispatch failed: %s", e)
        state["last_rows"] = len(rows)
        state["last_inserted"] = inserted
        state["inserted"] = int(state.get("inserted") or 0) + inserted
        state["last_ok_at"] = _now().isoformat()
        state["last_error"] = None
    except Exception as e:  # noqa: BLE001
        logger.warning("audit poll failed for %s: %s", conn.id, e)
        state["last_error"] = str(e)
    state["requests"] = int(state.get("requests") or 0) + requests
    await save_state(conn.id, state)
    return state


async def tick_all(*, budget_sec: float = TICK_BUDGET_SEC, pool: Any = None) -> list[dict[str, Any]]:
    """One cycle across every Verkada connection."""
    async with SessionLocal() as session:
        targets = await _verkada_connections(session)
    own_keys = [k for _, k, _ in targets]
    results = []
    for conn, key, region in targets:
        results.append(
            await tick_connection(conn, key, region, own_keys, budget_sec=budget_sec, pool=pool)
        )
    return results


async def run_loop(*, seconds: float = 55.0, interval: float = 10.0, pool: Any = None) -> dict[str, Any]:
    """Tick every ``interval`` seconds for about ``seconds``. The arq
    cron fires this once a minute, so the two together give a ten-second
    cadence without a long-lived process."""
    try:
        await scrub_placeholder_users()
    except Exception as e:  # noqa: BLE001
        logger.info("audit: placeholder scrub skipped: %s", e)
    stop = time.monotonic() + seconds
    ticks = 0
    while True:
        started = time.monotonic()
        await tick_all(pool=pool)
        ticks += 1
        if time.monotonic() + interval > stop:
            break
        elapsed = time.monotonic() - started
        await asyncio.sleep(max(0.0, interval - elapsed))
    return {"ticks": ticks}


async def request_backfill(days: int) -> list[dict[str, Any]]:
    """Reach further back than the initial backfill. Queues windows; the
    poller drains them on its usual budget."""
    async with SessionLocal() as session:
        targets = await _verkada_connections(session)
    now = int(time.time())
    out = []
    for conn, _, _ in targets:
        state = await load_state(conn.id)
        if state.get("cursor") is None:
            state["cursor"] = now - 60
        _ensure_backfill(state, now, days)
        await save_state(conn.id, state)
        out.append(state)
    return out


async def status() -> dict[str, Any]:
    """What the page shows in its poll pill: live / backfilling / stalled."""
    async with SessionLocal() as session:
        targets = await _verkada_connections(session)
        total = (await session.execute(select(func.count(AuditEvent.id)))).scalar() or 0
        newest = (await session.execute(select(func.max(AuditEvent.timestamp)))).scalar()
        oldest = (await session.execute(select(func.min(AuditEvent.timestamp)))).scalar()
    conns = []
    backlog_sec = 0
    total_sec = 0
    done_sec = 0
    last_ok: datetime | None = None
    last_error: str | None = None
    for conn, _, _ in targets:
        st = await load_state(conn.id)
        backlog = st.get("backlog") or []
        backlog_sec += sum(int(w[1]) - int(w[0]) for w in backlog)
        total_sec += int(st.get("backfill_total_sec") or 0)
        done_sec += int(st.get("backfill_done_sec") or 0)
        ok = _parse_ts(st.get("last_ok_at"))
        if ok and (last_ok is None or ok > last_ok):
            last_ok = ok
        if st.get("last_error"):
            last_error = st["last_error"]
        conns.append(
            {
                "connection_id": str(conn.id),
                "name": conn.name,
                "last_poll_at": st.get("last_poll_at"),
                "last_ok_at": st.get("last_ok_at"),
                "last_error": st.get("last_error"),
                "backlog_windows": len(backlog),
                "inserted": int(st.get("inserted") or 0),
                "requests": int(st.get("requests") or 0),
                "backfilled_from": st.get("backfilled_from"),
            }
        )
    age = (_now() - last_ok).total_seconds() if last_ok else None
    if not targets:
        phase = "unconfigured"
    elif last_error and (age is None or age > 60):
        phase = "error"
    elif age is None:
        phase = "starting"
    elif age > 90:
        phase = "stalled"
    elif backlog_sec > 0:
        phase = "backfilling"
    else:
        phase = "live"
    return {
        "phase": phase,
        "total": int(total),
        "newest": newest.isoformat() if newest else None,
        "oldest": oldest.isoformat() if oldest else None,
        "last_ok_at": last_ok.isoformat() if last_ok else None,
        "last_error": last_error,
        "backfill": {
            "total_sec": total_sec,
            "done_sec": min(done_sec, total_sec) if total_sec else 0,
            "remaining_sec": backlog_sec,
            "percent": (min(100.0, 100.0 * done_sec / total_sec) if total_sec else 100.0),
        },
        "connections": conns,
        "interval_sec": 10,
    }


def cutoff_for_retention(days: int) -> datetime:
    return _now() - timedelta(days=days)
