"""Fernet wrapper for credential encryption at rest.

The FERNET_KEY env var must be a 32-byte url-safe base64 string (what
``cryptography.fernet.Fernet.generate_key()`` produces). Losing it makes
every stored credential unrecoverable — that's the point.
"""

import json
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    if not settings.fernet_key:
        raise RuntimeError(
            "FERNET_KEY is not set. Generate one with "
            "`python -c 'from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())'` and put it in .env."
        )
    return Fernet(settings.fernet_key.encode())


def encrypt_secret(payload: dict[str, Any]) -> str:
    """Encrypt a dict to a string. Returns base64-encoded ciphertext."""
    plaintext = json.dumps(payload, separators=(",", ":")).encode()
    return _fernet().encrypt(plaintext).decode()


def decrypt_secret(ciphertext: str) -> dict[str, Any]:
    """Decrypt back to a dict. Raises InvalidToken if the key is wrong."""
    try:
        plaintext = _fernet().decrypt(ciphertext.encode())
    except InvalidToken as e:
        raise ValueError("decryption failed — wrong FERNET_KEY?") from e
    return json.loads(plaintext.decode())
