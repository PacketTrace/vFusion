"""The two keys everything else rests on, and where they came from.

``SECRET_KEY`` signs session cookies. ``FERNET_KEY`` encrypts every
stored credential. They fail in opposite directions and both failures
are silent:

* A weak ``SECRET_KEY`` means anyone can mint a valid session cookie.
  Nothing breaks, nothing is logged, and the app looks fine.
* A lost ``FERNET_KEY`` means every stored credential is unreadable.
  Nothing breaks until the day you restore from a backup.

``SECRET_KEY`` had shipped with a default of ``dev-secret-change-me``
in docker-compose and ``change-me-in-prod`` in .env.example, and
``deploy.sh`` never generated one. In a public repo that is a published
signing key: anyone who can reach an install that skipped the .env line
can forge ``v2:<epoch>:<iat>:<exp>:<nonce>.<hmac>`` and land inside as
admin. So this resolves it the way ``crypto.py`` already resolved the
Fernet key -- generate and persist on first boot -- which turns "the
operator had to know" into safe by default.
"""

from __future__ import annotations

import logging
import secrets as _secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from app.config import settings
from app.crypto import KEY_FILE as FERNET_KEY_FILE
from app.crypto import decrypt_secret
from app.crypto import SECRETS_DIR


logger = logging.getLogger(__name__)

SESSION_KEY_FILE = SECRETS_DIR / "session.key"

# Values that are public knowledge and therefore not keys. Anything in
# here is treated as though SECRET_KEY were unset.
PUBLISHED_DEFAULTS = frozenset(
    {
        "dev-secret-change-me",
        "change-me-in-prod",
        "changeme",
        "change-me",
        "secret",
        "supersecret",
        "please-change-me",
    }
)


@dataclass(frozen=True)
class KeyStatus:
    """Where a key came from and whether that is acceptable."""

    name: str
    source: str  # "env" | "file" | "generated"
    ok: bool
    detail: str
    created_at: str | None = None
    path: str | None = None


def _is_published(value: str) -> bool:
    return value.strip().lower() in PUBLISHED_DEFAULTS


def _file_created(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(
            path.stat().st_mtime, tz=timezone.utc
        ).isoformat()
    except OSError:
        return None


@lru_cache(maxsize=1)
def _resolve_session_key() -> tuple[bytes, str]:
    """(key bytes, where it came from). Generates and persists if needed."""
    configured = settings.secret_key or ""
    if configured and not _is_published(configured):
        return configured.encode("utf-8"), "env"

    if SESSION_KEY_FILE.exists():
        stored = SESSION_KEY_FILE.read_bytes().strip()
        if stored:
            return stored, "file"

    # Generating rather than refusing to boot. An install that cannot
    # start is worse than one that signs everybody out once, and the
    # only session this invalidates is one signed with a key that was
    # published in a public repo anyway.
    new_key = _secrets.token_urlsafe(48).encode("utf-8")
    try:
        SECRETS_DIR.mkdir(parents=True, exist_ok=True)
        SESSION_KEY_FILE.write_bytes(new_key + b"\n")
        try:
            SESSION_KEY_FILE.chmod(0o600)
        except OSError:
            # Bind mounts on some hosts do not support chmod. The docker
            # volume is access-controlled at the host level regardless.
            pass
    except OSError as e:
        # Persisting failed, so this key lasts until the next restart.
        # Still better than the published default: sessions break on
        # restart instead of being forgeable by anyone.
        logger.warning(
            "could not persist a session signing key to %s (%s) — sessions "
            "will not survive a restart. Set SECRET_KEY in .env, or check "
            "that the vfusion_secrets volume is mounted.",
            SESSION_KEY_FILE,
            e,
        )
        return new_key, "generated"

    if configured:
        logger.warning(
            "SECRET_KEY is set to a published default value — ignoring it "
            "and using a generated key persisted at %s. Anyone can forge a "
            "session cookie signed with a value published in the repo.",
            SESSION_KEY_FILE,
        )
    else:
        logger.warning(
            "SECRET_KEY not set — generated one and persisted it to %s. "
            "Back up the vfusion_secrets volume; losing it signs everyone "
            "out (recoverable) but losing fernet.key alongside it makes "
            "every stored credential unreadable (not recoverable).",
            SESSION_KEY_FILE,
        )
    return new_key, "file"


def session_key() -> bytes:
    return _resolve_session_key()[0]


def session_key_status() -> KeyStatus:
    _, source = _resolve_session_key()
    configured = settings.secret_key or ""
    if source == "env":
        return KeyStatus(
            name="SECRET_KEY",
            source="env",
            ok=True,
            detail="Supplied through the environment. Rotating it in .env signs everyone out.",
        )
    if source == "generated":
        return KeyStatus(
            name="SECRET_KEY",
            source="generated",
            ok=False,
            detail=(
                "Generated at boot but could not be written to disk, so every "
                "restart signs everyone out. Set SECRET_KEY in .env, or check "
                "that the vfusion_secrets volume is mounted at /app/secrets."
            ),
        )
    return KeyStatus(
        name="SECRET_KEY",
        source="file",
        ok=True,
        detail=(
            "Was set to a published default, so a generated key is being used instead."
            if configured and _is_published(configured)
            else "Generated on first boot and persisted to the secrets volume."
        ),
        created_at=_file_created(SESSION_KEY_FILE),
        path=str(SESSION_KEY_FILE),
    )


def fernet_key_status(connection_count: int) -> KeyStatus:
    """Where the credential-encryption key lives, and what depends on it."""
    depends = (
        f"{connection_count} stored connection"
        f"{'' if connection_count == 1 else 's'} would become unreadable "
        "without it."
    )
    if settings.fernet_key:
        return KeyStatus(
            name="FERNET_KEY",
            source="env",
            ok=True,
            detail=f"Supplied through the environment. {depends}",
        )
    if FERNET_KEY_FILE.exists():
        return KeyStatus(
            name="FERNET_KEY",
            source="file",
            ok=True,
            detail=(
                f"Generated on first boot, on the vfusion_secrets volume. {depends} "
                "Back that volume up — this key is not recoverable."
            ),
            created_at=_file_created(FERNET_KEY_FILE),
            path=str(FERNET_KEY_FILE),
        )
    return KeyStatus(
        name="FERNET_KEY",
        source="generated",
        ok=False,
        detail=(
            "No key file found and none in the environment. One will be "
            "generated on the next credential write; if the secrets volume "
            "is not mounted it will not survive a restart."
        ),
    )


async def rotate_fernet_key(session) -> dict[str, object]:
    """Re-encrypt every stored credential under a fresh key.

    Ordered so that no single failure leaves unreadable data:

    1. Decrypt everything with the current key first. If any row fails,
       nothing has been touched yet and the rotation simply aborts.
    2. Write the new key beside the old one as ``fernet.key.next``.
    3. Re-encrypt and commit.
    4. Only then promote the new key, keeping the old as ``.prev``.

    A crash between 3 and 4 is the one recoverable gap, and it is
    recoverable precisely because ``fernet.key.next`` is sitting there:
    the data is readable with it. That is why it is written before the
    commit rather than after.
    """
    import json as _json

    from cryptography.fernet import Fernet
    from sqlalchemy import select as _select

    from app.crypto import _fernet
    from app.models import Connection

    if settings.fernet_key:
        raise ValueError(
            "FERNET_KEY is supplied through the environment, so rotating it "
            "here would be overwritten on the next restart. Change it in "
            ".env instead — note that doing so makes existing credentials "
            "unreadable, so re-enter them afterwards."
        )

    rows = (await session.execute(_select(Connection))).scalars().all()

    # Step 1 — prove everything is readable before changing anything.
    plaintext: dict[object, dict] = {}
    for row in rows:
        if not row.encrypted_secret:
            continue
        plaintext[row.id] = decrypt_secret(row.encrypted_secret)

    # Step 2 — new key on disk, not yet in use.
    new_key = Fernet.generate_key()
    staged = SECRETS_DIR / "fernet.key.next"
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    staged.write_bytes(new_key + b"\n")
    try:
        staged.chmod(0o600)
    except OSError:
        pass

    # Step 3 — re-encrypt under it and commit.
    cipher = Fernet(new_key)
    for row in rows:
        if row.id not in plaintext:
            continue
        row.encrypted_secret = cipher.encrypt(
            _json.dumps(plaintext[row.id], separators=(",", ":")).encode()
        ).decode()
    await session.commit()

    # Step 4 — promote.
    if FERNET_KEY_FILE.exists():
        FERNET_KEY_FILE.replace(SECRETS_DIR / "fernet.key.prev")
    staged.replace(FERNET_KEY_FILE)
    _fernet.cache_clear()

    logger.warning(
        "rotated the credential encryption key; %s connection(s) re-encrypted. "
        "The previous key is kept at fernet.key.prev — delete it once you are "
        "satisfied, and back up the secrets volume again.",
        len(plaintext),
    )
    return {
        "rotated": True,
        "connections_reencrypted": len(plaintext),
        "previous_key_kept_at": str(SECRETS_DIR / "fernet.key.prev"),
    }
