"""Two-factor sign-in: a TOTP authenticator, and backup codes for the day
the phone is gone.

Optional, because vFusion is a single admin behind a LAN and a VPN for
most installs; recommended, because the one password guards a key that
can unlock doors. Enabling it is a deliberate three-step act -- scan,
prove the authenticator works by entering a code, confirm the password --
so nobody locks themselves out with a secret their phone never saw.

State lives next to the two master keys in ``/app/secrets`` (the
``vfusion_secrets`` volume), not in Postgres: the TOTP secret is as
sensitive as the Fernet key, a "Reset everything" wipe of the database
must not silently turn two-factor off, and backup-code hashes do not fit
``app_settings.value``. The secret is Fernet-encrypted inside the file
anyway; the file is defence in depth, not the only wall.

The login flow becomes two requests when this is on. The password
earns a short-lived signed *challenge* rather than a session; the code
redeems the challenge for the session. The challenge is HMAC-signed
with the session key and good for five minutes, so an attacker with the
password alone gets a five-minute token that opens nothing.

Backup codes are ten groups of eight characters, shown once, stored as
bcrypt hashes, and consumed on use. They are the recovery path and the
only one: there is no email, and the alternative -- delete the file on
the docker host -- is documented as such.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import bcrypt
import pyotp

from app.crypto import SECRETS_DIR, decrypt_secret, encrypt_secret
from app.security.keys import session_key

logger = logging.getLogger(__name__)

STATE_PATH = SECRETS_DIR / "mfa.json"
CHALLENGE_TTL_SEC = 5 * 60
PENDING_TTL_SEC = 15 * 60
BACKUP_CODES = 10
ISSUER = "vFusion"
ACCOUNT = "admin"
# A code is 30 s wide; accepting the neighbouring window forgives a
# phone that is a few seconds off without opening much.
VALID_WINDOW = 1


# ---- state file ------------------------------------------------------------


def _blank() -> dict[str, Any]:
    return {
        "enabled": False,
        "secret": None,          # Fernet token wrapping {"totp": <base32>}
        "enabled_at": None,
        "backup_hashes": [],     # bcrypt of the code, minus used ones
        "backup_issued": 0,
        "pending": None,         # {"secret": <fernet>, "issued": epoch}
        "last_used_step": None,  # replay guard: a TOTP step accepted once
    }


def _load() -> dict[str, Any]:
    try:
        raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _blank()
    base = _blank()
    if isinstance(raw, dict):
        base.update(raw)
    return base


def _save(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    tmp.replace(STATE_PATH)
    try:
        STATE_PATH.chmod(0o600)
    except OSError:
        pass


def _wrap(totp_secret: str) -> str:
    return encrypt_secret({"totp": totp_secret})


def _unwrap(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return (decrypt_secret(token) or {}).get("totp")
    except Exception:  # noqa: BLE001
        return None


# ---- public state -----------------------------------------------------------


def is_enabled() -> bool:
    return bool(_load().get("enabled"))


def status() -> dict[str, Any]:
    st = _load()
    return {
        "enabled": bool(st.get("enabled")),
        "enabled_at": st.get("enabled_at"),
        "backup_codes_remaining": len(st.get("backup_hashes") or []),
        "backup_codes_issued": int(st.get("backup_issued") or 0),
        "pending_setup": bool(st.get("pending")),
    }


# ---- setup ----------------------------------------------------------------


def begin_setup() -> dict[str, Any]:
    """A fresh secret, held as *pending* until a code proves the
    authenticator has it. Calling again replaces the pending one."""
    st = _load()
    secret = pyotp.random_base32()
    st["pending"] = {"secret": _wrap(secret), "issued": int(time.time())}
    _save(st)
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=ACCOUNT, issuer_name=ISSUER)
    return {"secret": secret, "otpauth_uri": uri, "matrix": qr_matrix(uri)}


def qr_matrix(payload: str) -> list[list[bool]]:
    """The QR as a grid, so the page can draw and animate every module
    itself and still hand a scanner a spec-correct code."""
    import segno

    q = segno.make(payload, error="m")
    return [[bool(x) for x in row] for row in q.matrix]


def complete_setup(code: str) -> list[str]:
    """Prove the pending secret works, switch it on, return the backup
    codes -- the only time they are ever shown in clear."""
    st = _load()
    pending = st.get("pending") or {}
    secret = _unwrap(pending.get("secret"))
    if not secret:
        raise ValueError("Start setup first: there is no pending secret.")
    if time.time() - float(pending.get("issued") or 0) > PENDING_TTL_SEC:
        st["pending"] = None
        _save(st)
        raise ValueError("That setup expired. Start again and scan the new code.")
    if not pyotp.TOTP(secret).verify(_clean(code), valid_window=VALID_WINDOW):
        raise ValueError("That code did not match. Check the phone's clock, then try the current code.")
    codes, hashes = _new_backup_codes()
    st.update(
        {
            "enabled": True,
            "secret": _wrap(secret),
            "enabled_at": datetime.now(timezone.utc).isoformat(),
            "backup_hashes": hashes,
            "backup_issued": len(codes),
            "pending": None,
            "last_used_step": None,
        }
    )
    _save(st)
    return codes


def disable() -> None:
    st = _blank()
    _save(st)


def regenerate_backup_codes() -> list[str]:
    st = _load()
    if not st.get("enabled"):
        raise ValueError("Two-factor is not on.")
    codes, hashes = _new_backup_codes()
    st["backup_hashes"] = hashes
    st["backup_issued"] = len(codes)
    _save(st)
    return codes


# ---- verifying ---------------------------------------------------------------


def _clean(code: str) -> str:
    return "".join(ch for ch in (code or "") if ch.isalnum()).upper()


def verify_code(code: str) -> str | None:
    """Accept a TOTP code or an unused backup code. Returns "totp",
    "backup", or None. A TOTP step is accepted once (replay guard); a
    backup code is consumed."""
    st = _load()
    if not st.get("enabled"):
        return None
    raw = _clean(code)
    secret = _unwrap(st.get("secret"))
    if secret and raw.isdigit() and len(raw) in (6, 7, 8):
        totp = pyotp.TOTP(secret)
        if totp.verify(raw, valid_window=VALID_WINDOW):
            step = int(time.time() // 30)
            if st.get("last_used_step") == step:
                return None
            st["last_used_step"] = step
            _save(st)
            return "totp"
    # Backup codes: 8 chars, letters and digits.
    if len(raw) == 8:
        pre = _pre(raw)
        for i, h in enumerate(st.get("backup_hashes") or []):
            try:
                if bcrypt.checkpw(pre, h.encode("utf-8")):
                    st["backup_hashes"].pop(i)
                    _save(st)
                    return "backup"
            except ValueError:
                continue
    return None


def _pre(code: str) -> bytes:
    return base64.b64encode(hashlib.sha256(code.encode("utf-8")).digest())


def _new_backup_codes() -> tuple[list[str], list[str]]:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I
    codes = ["".join(secrets.choice(alphabet) for _ in range(8)) for _ in range(BACKUP_CODES)]
    hashes = [bcrypt.hashpw(_pre(c), bcrypt.gensalt(rounds=10)).decode("utf-8") for c in codes]
    return [f"{c[:4]}-{c[4:]}" for c in codes], hashes


# ---- the login challenge ---------------------------------------------------


def make_challenge() -> str:
    """Issued after a correct password when two-factor is on. Proves the
    password step happened, opens nothing on its own."""
    exp = int(time.time()) + CHALLENGE_TTL_SEC
    nonce = secrets.token_urlsafe(12)
    body = f"mfa:{exp}:{nonce}"
    sig = hmac.new(session_key(), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_challenge(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    body, _, sig = token.rpartition(".")
    expect = hmac.new(session_key(), body.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expect):
        return False
    parts = body.split(":")
    if len(parts) != 3 or parts[0] != "mfa":
        return False
    try:
        return int(parts[1]) >= int(time.time())
    except ValueError:
        return False
