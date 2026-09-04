"""The security tab: what this install stands on, exposes, and holds.

Every value here is measured from the running install. There are no
static rows, because a checklist that reads the same on a healthy
install and a compromised one is decoration -- the whole point is to
say "your signing key is the published default" rather than "use a
strong signing key".
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth as auth_mod
from app.auth import (
    ADMIN_PASSWORD_HASH_KEY,
    SESSION_COOKIE,
    SESSION_LIFETIME_SEC,
    hash_password,
    make_session_token,
    validate_password_strength,
    verify_password,
)
from app.config import settings
from app.connectors.verkada.footage import CLIP_ROOT, IMAGE_ROOT
from app.db import get_session
from app.models import Connection, WebhookAsset
from app.security import keywatch, throttle
from app.security.keys import fernet_key_status, session_key_status
from app.security.surface import PUBLIC_PATH_PREFIXES, SURFACE_NOTES
from app.settings_store import (
    SETTINGS,
    get_str,
    invalidate_cache,
    set_value,
)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/security", tags=["security"])

EPOCH_KEY = "session_epoch"


# What is deliberately kept out of storage. Stated here so the operator
# can see it rather than take it on trust -- and so that if one of these
# ever regresses, the claim is somewhere visible instead of buried in a
# commit message.
REDACTIONS: list[dict[str, str]] = [
    {
        "what": "Footage stream tokens",
        "detail": (
            "HLS JWTs are stripped at the point the URL is built, so they "
            "never reach a stored run, a log line, or the browser."
        ),
    },
    {
        "what": "Raw badge data and keypad codes",
        "detail": (
            "input_value, raw_card and rawCard are excluded from the filter "
            "pickers, so raw card bits and door PINs cannot be selected into "
            "a flow condition and stored alongside it."
        ),
    },
    {
        "what": "Stored credentials",
        "detail": (
            "Connection secrets are Fernet-encrypted at rest and never "
            "returned by any endpoint, including this one."
        ),
    },
]


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


class KeywatchConfig(BaseModel):
    enabled: bool
    connection_id: str | None = None
    interval_hours: int = keywatch.DEFAULT_INTERVAL_HOURS


class ExpectedIps(BaseModel):
    ips: list[str]


class AlertAction(BaseModel):
    ip: str
    # True = "that was me", which adopts the address. False just clears
    # the alert without trusting it.
    adopt: bool = False


def _dir_size(path: Path) -> tuple[int, int]:
    total = 0
    count = 0
    try:
        for p in path.rglob("*"):
            if p.is_file():
                total += p.stat().st_size
                count += 1
    except OSError:
        pass
    return total, count


async def _bump_epoch(session: AsyncSession) -> int:
    """Invalidate every session cookie ever issued."""
    raw = await get_str(EPOCH_KEY)
    try:
        current = int(raw or 0)
    except (TypeError, ValueError):
        current = 0
    nxt = current + 1
    await set_value(session, EPOCH_KEY, str(nxt))
    await session.commit()
    invalidate_cache()
    auth_mod.set_epoch(nxt)
    return nxt


@router.get("/overview")
async def overview(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    conn_count = int(
        (await session.execute(select(func.count()).select_from(Connection))).scalar()
        or 0
    )

    keys = [session_key_status(), fernet_key_status(conn_count)]

    # Exposure, read from the list the middleware actually uses.
    exposure = []
    for prefix in PUBLIC_PATH_PREFIXES:
        note = SURFACE_NOTES.get(prefix) or {}
        if prefix in ("/docs", "/redoc", "/openapi.json") and not settings.enable_docs:
            continue
        exposure.append(
            {
                "path": prefix,
                "label": note.get("label") or prefix,
                "auth": note.get("auth") or "Unknown",
                "why": note.get("why") or "",
                "concern": note.get("concern"),
            }
        )

    asset_bytes, asset_count = (
        await session.execute(
            select(func.coalesce(func.sum(WebhookAsset.file_size), 0), func.count())
        )
    ).one()
    clip_bytes, clip_count = _dir_size(Path(CLIP_ROOT))
    image_bytes, image_count = _dir_size(Path(IMAGE_ROOT))

    retention = []
    for key, spec in SETTINGS.items():
        value = await get_str(key)
        retention.append(
            {
                "key": key,
                "label": spec.label,
                "unit": spec.unit,
                "value": value if value is not None else spec.default,
                "is_default": value is None,
            }
        )

    kw_state = await keywatch.load_state()
    kw_enabled = await keywatch.is_enabled()
    kw_conn = await get_str(keywatch.CONNECTION_KEY)
    kw_interval = await keywatch.interval_hours()

    return {
        "keys": [k.__dict__ for k in keys],
        "sessions": {
            "epoch": auth_mod.current_epoch(),
            "lifetime_days": round(SESSION_LIFETIME_SEC / 86400, 1),
            "cookie": {
                "httponly": True,
                "samesite": "lax",
                # Left off deliberately so the cookie works over plain
                # http on a LAN. Reported rather than hidden: on a
                # public deploy it is worth knowing.
                "secure": False,
            },
            "request_scheme": request.url.scheme,
            "throttle": throttle.status(),
        },
        "exposure": {
            "public_paths": exposure,
            "cors_origins": settings.cors_origin_list,
            "docs_enabled": settings.enable_docs,
        },
        "data": {
            "storage": [
                {"label": "Webhook assets", "bytes": int(asset_bytes or 0), "files": int(asset_count or 0)},
                {"label": "Gemini clips", "bytes": clip_bytes, "files": clip_count},
                {"label": "Gemini stills", "bytes": image_bytes, "files": image_count},
            ],
            "retention": retention,
            "redactions": REDACTIONS,
        },
        "keywatch": {
            "enabled": kw_enabled,
            "connection_id": kw_conn,
            "interval_hours": kw_interval,
            "state": kw_state,
        },
    }


@router.post("/password")
async def change_password(
    body: PasswordChange,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Change the admin password. Requires the current one.

    Sits behind the session gate (unlike /api/auth/*, which cannot be),
    so it needs both a live session and the existing password. It still
    goes through the throttle: it is a second oracle on the same secret,
    and one unthrottled guessing endpoint is as good as none.
    """
    wait = throttle.retry_after()
    if wait > 0:
        raise HTTPException(
            status_code=429,
            detail=f"Too many attempts. Try again in {int(wait) + 1}s.",
        )

    stored = await get_str(ADMIN_PASSWORD_HASH_KEY)
    if not stored:
        raise HTTPException(status_code=409, detail="No password is set yet.")
    if not verify_password(body.current_password, stored):
        cooldown = throttle.record_failure()
        detail = "Current password is incorrect."
        if cooldown:
            detail += f" Too many attempts — locked for {int(cooldown)}s."
        raise HTTPException(status_code=401, detail=detail)
    throttle.record_success()

    err = validate_password_strength(body.new_password)
    if err is not None:
        raise HTTPException(status_code=400, detail=err)
    if body.new_password == body.current_password:
        raise HTTPException(status_code=400, detail="That is the current password.")

    await set_value(session, ADMIN_PASSWORD_HASH_KEY, hash_password(body.new_password))
    await session.commit()
    invalidate_cache()

    # Every other session goes with it. A password change that leaves a
    # stolen cookie working is the shape of the problem, not a fix for
    # it. The caller gets a fresh cookie so they stay signed in here.
    epoch = await _bump_epoch(session)
    response.set_cookie(
        SESSION_COOKIE,
        make_session_token(),
        max_age=SESSION_LIFETIME_SEC,
        httponly=True,
        samesite="lax",
        path="/",
    )
    return {"changed": True, "other_sessions_ended": True, "epoch": epoch}


@router.post("/sign-out-everywhere")
async def sign_out_everywhere(
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Invalidate every session, including this one."""
    epoch = await _bump_epoch(session)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"epoch": epoch}


@router.post("/fernet/rotate")
async def rotate_fernet(
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    from app.security.keys import rotate_fernet_key

    try:
        return await rotate_fernet_key(session)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.put("/keywatch")
async def set_keywatch(
    body: KeywatchConfig,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    await set_value(session, keywatch.ENABLED_KEY, "1" if body.enabled else "0")
    await set_value(session, keywatch.CONNECTION_KEY, body.connection_id or None)
    await set_value(
        session, keywatch.INTERVAL_KEY, str(max(1, int(body.interval_hours)))
    )
    await session.commit()
    invalidate_cache()
    return {"enabled": body.enabled}


@router.post("/keywatch/check")
async def keywatch_check(
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Run one cycle now, rather than waiting for the cron.

    Returns the state either way. An exception here would surface as a
    500 that the page has nowhere to put, leaving it rendering the last
    thing it believed -- stale and confident, which is worse than an
    error.
    """
    from datetime import datetime, timezone

    try:
        state = await keywatch.run_check(session)
        await session.commit()
        return state
    except Exception as e:  # noqa: BLE001
        logger.exception("keywatch check failed")
        await session.rollback()
        state = await keywatch.load_state()
        state["last_check"] = datetime.now(timezone.utc).isoformat()
        state["last_error"] = f"{type(e).__name__}: {e}"
        await keywatch.save_state(session, state)
        await session.commit()
        return state


@router.post("/keywatch/expected-ips")
async def set_expected_ips(
    body: ExpectedIps,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    state = await keywatch.load_state()
    cleaned = [ip.strip() for ip in body.ips if ip.strip()]
    state["expected_ips"] = cleaned
    # An address that is now expected is no longer an alert.
    state["alerts"] = [a for a in state.get("alerts", []) if a.get("ip") not in cleaned]
    await keywatch.save_state(session, state)
    await session.commit()
    invalidate_cache()
    return state


@router.post("/keywatch/alerts/resolve")
async def resolve_alert(
    body: AlertAction,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    state = await keywatch.load_state()
    state["alerts"] = [a for a in state.get("alerts", []) if a.get("ip") != body.ip]
    if body.adopt:
        expected = list(state.get("expected_ips") or [])
        if body.ip not in expected:
            expected.append(body.ip)
        state["expected_ips"] = expected
    else:
        # Dismissed without adopting: forget what was seen from it, so a
        # fresh call from that address raises a new alert rather than
        # being silently folded into history.
        observed = dict(state.get("observed") or {})
        observed.pop(body.ip, None)
        state["observed"] = observed
    await keywatch.save_state(session, state)
    await session.commit()
    invalidate_cache()
    return state
