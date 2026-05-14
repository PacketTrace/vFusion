"""Verkada webhook signature verification.

Observed header format:

    verkada-signature: <unix-timestamp>|<hex-sha256>

We compute ``HMAC-SHA256(secret, f"{timestamp}.{body}")`` and constant-time
compare against the hex value. If Verkada's docs end up specifying a
different concatenation, ``verify`` returns False and the inbox marks the
event ``bad_signature`` — easy to spot and adjust.
"""

import hashlib
import hmac
import time
from typing import Literal


MAX_AGE_SECONDS = 600  # reject signatures older than 10 minutes (anti-replay)


SignatureStatus = Literal["verified", "bad_signature", "unverified", "missing_header"]


def verify(secret: str, header: str | None, body: bytes) -> SignatureStatus:
    """Return the verification result for a single request.

    - ``verified``        — HMAC matched and timestamp is recent
    - ``bad_signature``   — header present but HMAC didn't match (or too old)
    - ``missing_header``  — no verkada-signature header on the request
    - ``unverified`` is *not* returned here; the caller sets that when no
      Connection / signing secret exists yet for the org.
    """
    if not header:
        return "missing_header"

    try:
        ts_str, signature = header.split("|", 1)
        timestamp = int(ts_str)
    except (ValueError, AttributeError):
        return "bad_signature"

    if abs(time.time() - timestamp) > MAX_AGE_SECONDS:
        return "bad_signature"

    signed = f"{timestamp}.{body.decode('utf-8', errors='replace')}".encode()
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

    if hmac.compare_digest(expected, signature):
        return "verified"
    return "bad_signature"
