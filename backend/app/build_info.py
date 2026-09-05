"""What is actually running, so "did that deploy?" is answerable.

There is no git in the image and no build argument threaded through
compose, so the build id is derived from the source itself: a short
digest over every ``.py`` file's path, size and mtime. It changes when
the code changes and only then, which is the property that matters —
and it costs one directory walk at import.

Paired with the process start time, this answers the two questions that
came up repeatedly while building all of this: is the backend running
the code I just pushed, and did it actually restart.
"""

from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path


logger = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent

STARTED_AT = datetime.now(timezone.utc)
_STARTED_MONOTONIC = time.monotonic()


@lru_cache(maxsize=1)
def build_id() -> str:
    """Eight hex characters that change when the source does."""
    try:
        digest = hashlib.sha256()
        for path in sorted(APP_DIR.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            stat = path.stat()
            digest.update(str(path.relative_to(APP_DIR)).encode())
            digest.update(str(stat.st_size).encode())
            digest.update(str(int(stat.st_mtime)).encode())
        return digest.hexdigest()[:8]
    except OSError:
        # A build id that cannot be computed is not worth failing over;
        # "unknown" is honest and the timestamps still tell you whether
        # it restarted.
        logger.warning("could not compute a build id", exc_info=True)
        return "unknown"


def uptime_sec() -> int:
    return int(time.monotonic() - _STARTED_MONOTONIC)


def info() -> dict[str, str | int]:
    return {
        "build": build_id(),
        "started_at": STARTED_AT.isoformat(),
        "uptime_sec": uptime_sec(),
    }
