"""Two-factor management. Session-gated, unlike ``/api/auth``: turning
this on or off is something only a signed-in admin does, and every
change here also re-checks the password so a walked-away-from browser
cannot do it alone."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.auth import ADMIN_PASSWORD_HASH_KEY, verify_password
from app.security import mfa, throttle
from app.settings_store import get_str

router = APIRouter(prefix="/api/mfa", tags=["mfa"])


class PasswordIn(BaseModel):
    password: str


class CodeAndPasswordIn(BaseModel):
    password: str
    code: str


async def _require_password(password: str) -> None:
    wait = throttle.retry_after()
    if wait > 0:
        raise HTTPException(429, f"Too many attempts. Try again in {int(wait) + 1}s.")
    stored = await get_str(ADMIN_PASSWORD_HASH_KEY)
    if not stored or not verify_password(password, stored):
        throttle.record_failure()
        raise HTTPException(401, "Wrong password.")
    throttle.record_success()


@router.get("")
async def get_status() -> dict[str, Any]:
    return mfa.status()


@router.post("/setup")
async def setup(body: PasswordIn) -> dict[str, Any]:
    """A new pending secret and its QR. Nothing changes until a code
    proves the authenticator has it."""
    await _require_password(body.password)
    return mfa.begin_setup()


@router.post("/enable")
async def enable(body: CodeAndPasswordIn) -> dict[str, Any]:
    await _require_password(body.password)
    try:
        codes = mfa.complete_setup(body.code)
    except ValueError as e:
        throttle.record_failure()
        raise HTTPException(400, str(e)) from e
    return {"enabled": True, "backup_codes": codes, **mfa.status()}


@router.post("/disable")
async def disable(body: CodeAndPasswordIn) -> dict[str, Any]:
    """Password *and* a current code: losing the phone is what backup
    codes are for, and either kind of code is accepted here."""
    await _require_password(body.password)
    if not mfa.is_enabled():
        return mfa.status()
    if mfa.verify_code(body.code) is None:
        throttle.record_failure()
        raise HTTPException(400, "That code did not match.")
    mfa.disable()
    return mfa.status()


@router.post("/backup-codes")
async def regenerate(body: CodeAndPasswordIn) -> dict[str, Any]:
    await _require_password(body.password)
    if mfa.verify_code(body.code) is None:
        throttle.record_failure()
        raise HTTPException(400, "That code did not match.")
    try:
        codes = mfa.regenerate_backup_codes()
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"backup_codes": codes, **mfa.status()}
