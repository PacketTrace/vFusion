"""Verkada webhook signature verification.

Implements Verkada's documented signature scheme:

    Verkada-Signature: <unix-timestamp>|<hex-sha256>

The signed payload is the raw request body concatenated with the
literal byte ``|`` and the timestamp string:

    HMAC-SHA256(shared_secret, body + b"|" + timestamp_bytes)

The result is compared constant-time against the signature half of
the header.

**Verification is binary by design.** The result is either
``verified`` (HMAC matched, timestamp within tolerance) or
``unverified`` (anything else — wrong secret, stale timestamp from a
Verkada retry, mutated body, missing header, etc.). We deliberately
*don't* surface a loud "bad signature" status because:

  - Verkada doesn't re-sign retries, so a redelivery past the
    tolerance window is a perfectly legitimate event with a stale
    timestamp. Calling that "bad" creates noise.
  - If an attacker actually has the signing secret, they can produce
    signatures that verify cleanly — so a red chip doesn't catch them
    anyway. The shared secret IS the security boundary.

When you actually need to know *why* something didn't verify,
``docker compose logs backend | grep "verkada signature"`` carries
the full reason at WARN level — kept in code, just not surfaced to
the UI as a scary chip.

Cross-reference: Verkada API Docs → Webhooks → Verifying Signature.
"""

import hashlib
import hmac
import logging
import time
from typing import Literal


# Verkada's docs use a 60-second tolerance in the *signing* example,
# but their retry behavior doesn't re-sign — a redelivered webhook
# carries the original timestamp. A 5-minute window absorbs almost
# all legitimate retries while still bounding replay risk.
MAX_AGE_SECONDS = 300


logger = logging.getLogger(__name__)


SignatureStatus = Literal["verified", "unverified", "missing_header"]


def verify(secret: str, header: str | None, body: bytes) -> SignatureStatus:
    """Return the verification result for a single request.

    - ``verified``       — HMAC matched and timestamp within tolerance
    - ``unverified``     — anything else (HMAC mismatch, stale, malformed)
    - ``missing_header`` — request had no Verkada-Signature header

    The verbose reason for each non-verified outcome is logged at WARN
    level so operators can trace specific failures via container logs
    without the UI screaming on every retry.
    """
    if not header:
        return "missing_header"

    try:
        ts_str, signature = header.split("|", 1)
        timestamp = int(ts_str)
    except (ValueError, AttributeError):
        logger.warning("verkada signature: malformed header %r", header)
        return "unverified"

    # Verkada's reference implementation:
    #   to_hash = b"|".join((body, timestamp.encode()))
    # which is identical to body + b"|" + ts_str.encode(). We keep the
    # body as raw bytes (don't decode) so non-UTF-8 payloads still hash
    # to the same value as Verkada's signer.
    signed = body + b"|" + ts_str.encode()
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    hmac_ok = hmac.compare_digest(expected, signature)

    # Compute the age regardless so the log line carries the real
    # reason. We treat a stale-but-HMAC-good event and an HMAC-mismatch
    # event identically at the chip level — both collapse to
    # "unverified". The distinction lives in the logs.
    age = time.time() - timestamp
    timestamp_ok = abs(age) <= MAX_AGE_SECONDS

    if hmac_ok and timestamp_ok:
        return "verified"

    if hmac_ok and not timestamp_ok:
        # Legitimate Verkada retry that crossed the tolerance window.
        # Very common; not actionable. Logged at INFO so it doesn't
        # clutter WARN-level alerts.
        logger.info(
            "verkada signature: HMAC matched but timestamp %s is %.0fs out "
            "of tolerance (max %ds) — likely a Verkada retry",
            ts_str,
            age,
            MAX_AGE_SECONDS,
        )
    else:
        # Actual HMAC mismatch. This is the one operators might care
        # about (wrong secret, body mutation in transit, spoofed
        # traffic). Logged at WARN so it shows up in alert channels.
        logger.warning(
            "verkada signature: HMAC mismatch (ts=%s, expected=%s…, got=%s…) — "
            "wrong signing secret, body mutated in flight, or spoofed traffic",
            ts_str,
            expected[:8],
            signature[:8] if signature else "",
        )
    return "unverified"
