"""Single-user admin authentication.

vFusion runs single-tenant: one admin password gates the dashboard and
the admin API. The password is hashed with bcrypt (cost 12) and the
hash is stored in ``app_settings`` under the ``admin_password_hash``
key. Hashing — not encryption — is intentional: a compromised database
must not be reversible to plaintext.

Sessions carry an HMAC-signed cookie with the issuance and expiry
timestamps, plus an *epoch*. That epoch is the only piece of
server-side session state, and it is what makes revocation possible:
bumping it invalidates every cookie ever issued. "Sign out everywhere"
and "changing your password ends other sessions" both rely on it.

Without it, a stolen cookie stayed valid for its full seven days no
matter what the operator did -- the signing key is independent of the
password, so changing the password did nothing to sessions already out
there.

The signing key comes from ``app.security.keys``, which refuses the
published defaults that used to ship in docker-compose and
.env.example.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

import bcrypt

from app.security.keys import session_key


SESSION_COOKIE = "vfusion_session"
# 7 days. Tradeoff: long enough that operators don't re-auth daily,
# short enough that a stolen cookie eventually goes stale.
SESSION_LIFETIME_SEC = 7 * 24 * 3600

ADMIN_PASSWORD_HASH_KEY = "admin_password_hash"

# Sanity bounds — bcrypt rejects passwords longer than 72 bytes anyway,
# but we accept long passphrases by pre-hashing with SHA-256 first so
# the operator can use a 100-char passphrase without silent truncation.
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 256


def hash_password(password: str) -> str:
    """Bcrypt with cost 12. SHA-256 pre-digest so passphrases longer than
    72 bytes don't get silently truncated by bcrypt."""
    digest = hashlib.sha256(password.encode("utf-8")).digest()
    # bcrypt's input must be <=72 bytes; SHA-256 gives us 32. Base64-encode
    # to keep it printable (some bcrypt libs object to embedded NULs).
    pre = base64.b64encode(digest)
    return bcrypt.hashpw(pre, bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, stored_hash: str) -> bool:
    if not password or not stored_hash:
        return False
    try:
        digest = hashlib.sha256(password.encode("utf-8")).digest()
        pre = base64.b64encode(digest)
        return bcrypt.checkpw(pre, stored_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# The current session epoch, cached in-process. Loaded once at startup
# (see main.py's lifespan) and updated in place whenever it is bumped,
# so verifying a cookie stays a pure function -- the session middleware
# runs on every request and cannot afford a database round trip.
_epoch: int = 0


def current_epoch() -> int:
    return _epoch


def set_epoch(value: int) -> None:
    """Update the cached epoch. Callers persist it separately."""
    global _epoch
    _epoch = int(value)


def _signing_key() -> bytes:
    return session_key()


def _sign(payload: str) -> str:
    return hmac.new(_signing_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def make_session_token() -> str:
    """Return a self-contained ``payload.signature`` token. Payload format:
    ``v2:<epoch>:<issued_at>:<expires_at>:<nonce>``. The nonce keeps two
    cookies minted in the same second from being identical; the epoch is
    what lets every cookie be revoked at once."""
    now = int(time.time())
    nonce = secrets.token_hex(8)
    payload = f"v2:{current_epoch()}:{now}:{now + SESSION_LIFETIME_SEC}:{nonce}"
    return f"{payload}.{_sign(payload)}"


def verify_session_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    payload, sig = token.rsplit(".", 1)
    # Constant-time compare to avoid timing oracles on the HMAC.
    if not hmac.compare_digest(_sign(payload), sig):
        return False
    parts = payload.split(":")
    # v2:<epoch>:<iat>:<exp>:<nonce>. v1 tokens are rejected rather than
    # honoured: they predate revocation, and the only installs holding
    # one signed it with a key that may well have been the published
    # default. Signing everyone out once is the correct upgrade path.
    if len(parts) != 5 or parts[0] != "v2":
        return False
    try:
        epoch = int(parts[1])
        exp = int(parts[3])
    except ValueError:
        return False
    if epoch != current_epoch():
        return False
    return time.time() < exp


def validate_password_strength(password: str) -> str | None:
    """Return None if acceptable, else a human-readable error string."""
    if not isinstance(password, str):
        return "Password must be a string."
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
    return None
