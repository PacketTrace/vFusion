"""Rate limiting for the password endpoints.

Login had none. One password guards an app holding a Verkada key that
can unlock doors, and ``/api/auth/login`` would answer an unlimited
number of guesses as fast as they arrived. ``/change-password`` adds a
second oracle on the same secret, so both go through here.

Deliberately **global** rather than per-IP. vFusion is single-user, so
there is exactly one legitimate password-guesser, and a per-IP counter
is worse than useless behind a reverse proxy or Cloudflare Tunnel:
every request arrives from the proxy, so either everyone shares one
bucket anyway or an attacker rotates ``X-Forwarded-For`` and gets a
fresh bucket per request. A global limit cannot be evaded by changing
where you come from.

The cost of being wrong is a short wait for one operator who fat-
fingered their password. The cost of being right is that an offline-
speed guessing attack becomes an online-speed one.

In-process state, no Redis. It only needs to outlive an attack, not a
restart, and an attacker cannot restart the container.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


# Attempts before cooldowns begin. Enough for a genuine typo or three.
FREE_ATTEMPTS = 5

# Cooldown doubles per failure past the free ones: 5s, 10s, 20s ... to a
# ceiling. Even the floor takes an online attack from thousands of
# guesses a second to fewer than one, which is the whole game.
BASE_COOLDOWN_SEC = 5.0
MAX_COOLDOWN_SEC = 15 * 60.0

# Failures older than this stop counting, so an operator who mistyped
# their password last Tuesday is not still being punished for it.
DECAY_SEC = 30 * 60.0


@dataclass
class _State:
    failures: int = 0
    last_failure: float = 0.0
    locked_until: float = 0.0
    total_failures: int = field(default=0)


_state = _State()


def _decay(now: float) -> None:
    if _state.failures and now - _state.last_failure > DECAY_SEC:
        _state.failures = 0
        _state.locked_until = 0.0


def retry_after(now: float | None = None) -> float:
    """Seconds until another attempt is allowed. 0.0 when unlocked."""
    now = time.time() if now is None else now
    _decay(now)
    return max(0.0, _state.locked_until - now)


def record_failure() -> float:
    """Note a wrong password. Returns the new cooldown in seconds."""
    now = time.time()
    _decay(now)
    _state.failures += 1
    _state.total_failures += 1
    _state.last_failure = now
    over = _state.failures - FREE_ATTEMPTS
    if over <= 0:
        return 0.0
    cooldown = min(BASE_COOLDOWN_SEC * (2 ** (over - 1)), MAX_COOLDOWN_SEC)
    _state.locked_until = now + cooldown
    return cooldown


def record_success() -> None:
    """A correct password clears the slate."""
    _state.failures = 0
    _state.locked_until = 0.0


def status() -> dict[str, float | int | bool]:
    """For the security page. Counts survive a successful login so the
    operator can see that something was hammering the endpoint even
    though it eventually stopped."""
    now = time.time()
    return {
        "recent_failures": _state.failures,
        "total_failures_since_boot": _state.total_failures,
        "locked": retry_after(now) > 0,
        "retry_after_sec": round(retry_after(now), 1),
        "last_failure_ago_sec": (
            round(now - _state.last_failure, 1) if _state.last_failure else -1
        ),
        "free_attempts": FREE_ATTEMPTS,
    }
