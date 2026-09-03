"""Field shapes learned from the bundled webhook samples.

``fixtures/`` holds one real, scrubbed payload per event variant we have
ever been handed. Until now nothing read them -- they were documentation,
and the filter picker learned exclusively from whatever the operator's
own database happened to contain.

That made the product cold-start blind: a fresh install has no webhook
history, so every event type offered family-level guesses with no values,
and the shapes we *did* know shipped in the repo without ever reaching
the running app. A sample of ``door_code_entered_accepted`` knows things
the Pydantic model cannot express -- ``user_info`` is typed ``Any``, so
``user_info.email`` exists only in the payload -- and we were throwing
that away.

Paths only, never values. Fixture values are scrubbed placeholders
("Jordan Sample", "Front Door"), so suggesting them as filter values
would be inventing data. Real values still come from real events.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator


logger = logging.getLogger(__name__)

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def paths_for(
    key: str | None,
    walk: Callable[[dict[str, Any]], Iterable[tuple[str, Any]]],
) -> dict[str, str]:
    """Dotted paths a bundled sample of ``key`` actually populates.

    Takes the walker as an argument so the fixture and the live-payload
    code paths cannot drift: whatever exclusions apply to stored events
    (credentials, per-event ids) apply here by construction.
    """
    if not key:
        return {}
    payload = _payload_for(key)
    if payload is None:
        return {}
    data = payload.get("data")
    if not isinstance(data, dict):
        return {}
    return {
        path: "array" if isinstance(value, list) else type(value).__name__
        for path, value in walk(data)
    }


@lru_cache(maxsize=1)
def _payloads() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    try:
        files = sorted(FIXTURE_DIR.glob("*.json"))
    except OSError as e:
        logger.warning("could not list %s: %s", FIXTURE_DIR, e)
        return out
    for path in files:
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("skipping fixture %s: %s", path.name, e)
            continue
        if not isinstance(payload, dict):
            continue
        data = payload.get("data")
        key = None
        if isinstance(data, dict):
            key = data.get("notification_type")
        key = key or payload.get("webhook_type")
        if isinstance(key, str) and key:
            out[key] = payload
    return out


def _payload_for(key: str) -> dict[str, Any] | None:
    return _payloads().get(key)


def known_keys() -> Iterator[str]:
    """Every event type we hold a bundled sample for."""
    return iter(sorted(_payloads()))
