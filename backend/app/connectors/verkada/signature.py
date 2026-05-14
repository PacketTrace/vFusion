"""Verkada webhook signature verification.

Implements Verkada's documented signature scheme:

    Verkada-Signature: <unix-timestamp>|<hex-sha256>

The signed payload is the raw request body concatenated with the
literal byte ``|`` and the timestamp string:

    HMAC-SHA256(shared_secret, body + b"|" + timestamp_bytes)

The result is compared constant-time against the signature half of
the header. Per Verkada's docs, the timestamp also has to be within
a short tolerance window to defeat replay attacks.

Cross-reference: Verkada API Docs → Webhooks → Verifying Signature.
"""

import hashlib
import hmac
import logging
import time
from typing import Literal


# Verkada's documented sample code uses a 60-second tolerance. We keep
# the same to match the reference behavior. If real-world clock drift
# / network latency causes false rejections in production, bump this.
MAX_AGE_SECONDS = 60


logger = logging.getLogger(__name__)


SignatureStatus = Literal["verified", "bad_signature", "unverified", "missing_header"]


def verify(secret: str, header: str | None, body: bytes) -> SignatureStatus:
    """Return the verification result for a single request.

    - ``verified``        — HMAC matched and timestamp is recent
    - ``bad_signature``   — header present but HMAC didn't match (or too old)
    - ``missing_header``  — no Verkada-Signature header on the request
    - ``unverified`` is *not* returned here; the caller sets that when no
      Connection / signing secret exists yet for the org.

    Reason for each non-success outcome is logged at WARN level so it
    surfaces in ``docker compose logs backend`` when a real production
    webhook fails — way easier than re-reading inboxed bytes by hand.
    """
    if not header:
        return "missing_header"

    try:
        ts_str, signature = header.split("|", 1)
        timestamp = int(ts_str)
    except (ValueError, AttributeError):
        logger.warning("verkada signature: malformed header %r", header)
        return "bad_signature"

    age = time.time() - timestamp
    if abs(age) > MAX_AGE_SECONDS:
        logger.warning(
            "verkada signature: timestamp %s is %.1fs out of tolerance "
            "(max %ds) — likely clock drift or replay",
            ts_str,
            age,
            MAX_AGE_SECONDS,
        )
        return "bad_signature"

    # Verkada's reference implementation:
    #   to_hash = b"|".join((body, timestamp.encode()))
    # which is identical to body + b"|" + ts_str.encode(). We keep the
    # body as raw bytes (don't decode) so non-UTF-8 payloads still hash
    # to the same value as Verkada's signer.
    signed = body + b"|" + ts_str.encode()
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

    if hmac.compare_digest(expected, signature):
        return "verified"

    logger.warning(
        "verkada signature: HMAC mismatch (ts=%s, expected=%s…, got=%s…) — "
        "wrong signing secret, or body mutated in flight",
        ts_str,
        expected[:8],
        signature[:8] if signature else "",
    )
    return "bad_signature"
