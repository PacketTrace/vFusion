"""Is there a newer vFusion than the one running, and how to get it.

A container cannot replace itself. Whatever pulls a new image has to
run outside it, with a socket or a shell that this process must not
have -- mounting the Docker socket into an app that holds a key which
opens doors trades the whole security story for one button. So this
checks and tells; it never downloads, never writes to disk outside its
own cache, and never restarts anything. The operator runs the command.

What it does:

* Asks GitHub for the repository's releases, at most once every six
  hours, and remembers the answer on the assets volume so a restart
  does not re-ask.
* Compares the newest release on the configured channel against
  ``build_info.VERSION`` and reports the difference.
* Remembers a dismissal *by version*, so hiding the banner for 1.2.0
  does not also hide 1.3.0.

Two channels, because the project ships from two branches.
``UPDATE_CHANNEL=beta`` (the default while beta is where the work is)
considers every published release; ``stable`` considers only releases
GitHub does not mark as a pre-release. Drafts are never visible to an
unauthenticated caller and are filtered anyway.

Set ``UPDATE_CHANNEL=off`` to disable. The check is an unauthenticated
GET to api.github.com carrying no version, no org id and no identifier
of any kind -- but it is still an outbound request from this host, and
somebody deploying on an isolated network is entitled to turn it off
rather than watch it fail.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

from app import build_info

logger = logging.getLogger(__name__)

REPO = "PacketTrace/vFusion"
RELEASES_URL = f"https://api.github.com/repos/{REPO}/releases?per_page=20"
RELEASES_PAGE = f"https://github.com/{REPO}/releases"

STATE_PATH = Path(os.environ.get("UPDATE_STATE_DIR", "/app/data")) / "update.json"

OK_TTL = 6 * 3600
FAIL_TTL = 30 * 60
TIMEOUT = 10.0

_lock = asyncio.Lock()
_state: dict[str, Any] | None = None


# ---------------------------------------------------------------- state


def _load() -> dict[str, Any]:
    global _state
    if _state is None:
        try:
            _state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _state = {}
    return _state


def _save(state: dict[str, Any]) -> None:
    global _state
    _state = state
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        tmp.replace(STATE_PATH)
    except OSError:
        # A cache that cannot be written costs one extra request per
        # restart. Not worth failing a page render over.
        logger.warning("could not persist the update-check cache", exc_info=True)


# -------------------------------------------------------------- version

_VERSION_RE = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$")


def parse(version: str) -> tuple[int, int, int, str] | None:
    """``v1.2.3-rc1`` -> ``(1, 2, 3, "rc1")``. None if unparseable."""
    m = _VERSION_RE.match((version or "").strip())
    if not m:
        return None
    return (
        int(m.group(1)),
        int(m.group(2) or 0),
        int(m.group(3) or 0),
        m.group(4) or "",
    )


def is_newer(candidate: str, current: str) -> bool:
    """Strictly greater on the numeric triple.

    A pre-release suffix is deliberately ignored rather than ordered.
    Semver says 1.2.0-rc1 precedes 1.2.0, which is correct and useless
    here: the tags this project publishes are plain triples, and the
    alternative is a comparison that silently offers a downgrade if a
    suffix convention ever changes. Equal numbers mean no update.
    """
    a, b = parse(candidate), parse(current)
    if a is None or b is None:
        return False
    return a[:3] > b[:3]


# --------------------------------------------------------------- fetch


def channel() -> str:
    raw = (os.environ.get("UPDATE_CHANNEL") or "beta").strip().lower()
    return raw if raw in ("beta", "stable", "off") else "beta"


def _pick(releases: list[dict[str, Any]], chan: str) -> dict[str, Any] | None:
    """Newest release on the channel, as GitHub already sorts them."""
    for rel in releases:
        if rel.get("draft"):
            continue
        if chan == "stable" and rel.get("prerelease"):
            continue
        if not rel.get("tag_name"):
            continue
        return rel
    return None


async def _fetch(chan: str) -> dict[str, Any]:
    """One call to GitHub, reduced to the four fields anyone needs."""
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "vFusion-update-check",
    }
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(RELEASES_URL, headers=headers)
    resp.raise_for_status()
    rel = _pick(resp.json(), chan)
    if rel is None:
        return {"latest": None}
    return {
        "latest": str(rel.get("tag_name", "")).lstrip("v"),
        "name": rel.get("name") or rel.get("tag_name"),
        "url": rel.get("html_url") or RELEASES_PAGE,
        "published_at": rel.get("published_at"),
        "prerelease": bool(rel.get("prerelease")),
    }


async def check(force: bool = False) -> dict[str, Any]:
    """The banner's whole answer, cached.

    Never raises. A GitHub outage, a rate limit or an air-gapped host
    all come back as ``checked: false`` with the reason attached, which
    the UI renders as nothing at all -- an install that cannot reach
    GitHub is not a problem the operator needs a red box about.
    """
    current = build_info.VERSION
    chan = channel()
    base: dict[str, Any] = {
        "enabled": chan != "off",
        "channel": chan,
        "current": current,
        "update_available": False,
        "checked": False,
        "latest": None,
        "url": RELEASES_PAGE,
        "dismissed": False,
        "error": None,
    }
    if chan == "off":
        return base

    async with _lock:
        state = dict(_load())
        cached = state.get("result") or {}
        fetched_at = float(state.get("fetched_at") or 0)
        ttl = OK_TTL if cached.get("latest") else FAIL_TTL
        fresh = (time.time() - fetched_at) < ttl
        same_channel = state.get("channel") == chan

        if force or not fresh or not same_channel:
            try:
                cached = await _fetch(chan)
                state = {
                    **state,
                    "result": cached,
                    "fetched_at": time.time(),
                    "channel": chan,
                    "error": None,
                }
            except Exception as exc:  # noqa: BLE001
                reason = type(exc).__name__
                if isinstance(exc, httpx.HTTPStatusError):
                    reason = f"github returned {exc.response.status_code}"
                logger.info("update check failed: %s", reason)
                state = {**state, "fetched_at": time.time(), "error": reason}
            _save(state)

        dismissed = state.get("dismissed")

    base["error"] = state.get("error")
    latest = cached.get("latest")
    if not latest:
        return base

    base.update(
        checked=True,
        latest=latest,
        name=cached.get("name"),
        published_at=cached.get("published_at"),
        prerelease=cached.get("prerelease"),
        url=cached.get("url") or RELEASES_PAGE,
        update_available=is_newer(latest, current),
        dismissed=dismissed == latest,
        checked_at=state.get("fetched_at"),
    )
    return base


async def dismiss(version: str) -> None:
    """Hide the banner for exactly this version."""
    async with _lock:
        _save({**dict(_load()), "dismissed": version})
