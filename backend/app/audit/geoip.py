"""Where an audit-log IP address is, roughly.

An audit row says *who* and *from which address*; the question an
operator actually has is "was that from the office or from somewhere
they should not be". City-level geolocation answers most of it.

Provider is ip-api.com's batch endpoint: no key, no signup, 100
addresses per call, 15 calls a minute on the free tier -- and an org's
audit log has a few dozen distinct addresses, not thousands. Results
are cached on the assets volume for 30 days (addresses do not move
much), failures for an hour. Private and loopback addresses are never
sent anywhere; they are labelled as local.

Set ``GEOIP_PROVIDER=off`` to disable lookups entirely. The addresses
are the only thing sent, and only when the page asks.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

CACHE_PATH = Path(os.environ.get("AUDIT_STATE_DIR", "/app/data/audit")) / "geoip.json"
OK_TTL = 30 * 86400
FAIL_TTL = 3600
BATCH_URL = "http://ip-api.com/batch"
BATCH_MAX = 100
FIELDS = "status,message,country,countryCode,regionName,city,lat,lon,isp,org,as,query,proxy,hosting"

_lock = asyncio.Lock()
_cache: dict[str, dict[str, Any]] | None = None


def _load() -> dict[str, dict[str, Any]]:
    global _cache
    if _cache is not None:
        return _cache
    try:
        raw = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        _cache = raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        _cache = {}
    return _cache


def _save() -> None:
    if _cache is None:
        return
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(_cache, separators=(",", ":")), encoding="utf-8")
        tmp.replace(CACHE_PATH)
    except OSError:
        logger.warning("could not persist geoip cache", exc_info=True)


def _local(ip: str) -> dict[str, Any] | None:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return {"ok": False, "error": "not an IP address"}
    if addr.is_private or addr.is_loopback or addr.is_link_local:
        return {"ok": True, "local": True, "label": "local network"}
    return None


def _label(g: dict[str, Any]) -> str:
    parts = [p for p in (g.get("city"), g.get("region")) if p]
    country = g.get("country_code") or g.get("country")
    if country and (not parts or g.get("country_code") != "US"):
        parts.append(str(country))
    return ", ".join(parts) if parts else "unknown"


async def lookup_many(ips: list[str]) -> dict[str, dict[str, Any]]:
    """Geo for each address. Cached; only misses go to the provider."""
    now = time.time()
    out: dict[str, dict[str, Any]] = {}
    wanted: list[str] = []
    async with _lock:
        cache = _load()
        for ip in dict.fromkeys(i.strip() for i in ips if i and i.strip()):
            loc = _local(ip)
            if loc is not None:
                out[ip] = loc
                continue
            hit = cache.get(ip)
            if hit and now - float(hit.get("ts") or 0) < (OK_TTL if hit.get("ok") else FAIL_TTL):
                out[ip] = hit
                continue
            wanted.append(ip)
    if not wanted or settings.geoip_provider == "off":
        for ip in wanted:
            out[ip] = {"ok": False, "error": "lookups disabled"}
        return out

    fetched: dict[str, dict[str, Any]] = {}
    for i in range(0, len(wanted), BATCH_MAX):
        chunk = wanted[i : i + BATCH_MAX]
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                res = await client.post(
                    BATCH_URL, params={"fields": FIELDS}, json=[{"query": ip} for ip in chunk]
                )
            if res.status_code == 429:
                raise RuntimeError("rate limited")
            res.raise_for_status()
            rows = res.json()
        except Exception as e:  # noqa: BLE001
            logger.info("geoip batch failed: %s", e)
            for ip in chunk:
                fetched[ip] = {"ok": False, "error": str(e)[:120], "ts": now}
            continue
        if not isinstance(rows, list):
            rows = []
        by_query = {r.get("query"): r for r in rows if isinstance(r, dict)}
        for ip in chunk:
            r = by_query.get(ip)
            if not r or r.get("status") != "success":
                fetched[ip] = {
                    "ok": False,
                    "error": (r or {}).get("message") or "no result",
                    "ts": now,
                }
                continue
            g = {
                "ok": True,
                "city": r.get("city") or None,
                "region": r.get("regionName") or None,
                "country": r.get("country") or None,
                "country_code": r.get("countryCode") or None,
                "lat": r.get("lat"),
                "lon": r.get("lon"),
                "isp": r.get("isp") or None,
                "org": r.get("org") or None,
                "asn": r.get("as") or None,
                "proxy": bool(r.get("proxy")),
                "hosting": bool(r.get("hosting")),
                "ts": now,
            }
            g["label"] = _label(g)
            fetched[ip] = g
    async with _lock:
        cache = _load()
        cache.update(fetched)
        _save()
    out.update(fetched)
    return out
