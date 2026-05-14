"""Public-config endpoint.

Tells the frontend what kind of webhook ingress is active and which URL
to display in the Webhook Inbox banner so users know what to paste into
Verkada Command.

Three modes:
  - **quick**  — TryCloudflare ephemeral URL, auto-discovered from
    cloudflared's metrics endpoint. Hostname changes on every restart.
  - **named**  — operator set ``PUBLIC_WEBHOOK_BASE`` in ``.env`` (their
    own domain behind a Cloudflare named tunnel). Stable.
  - **lan**    — no tunnel running; backend is only reachable on the LAN
    or via VPN/Tailscale. We hand back ``null`` and let the UI fall back
    to its local-origin guess.
"""

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings


router = APIRouter(prefix="/api/config", tags=["config"])


# The cloudflared service in the ``quick`` compose profile binds its
# metrics server on this hostname:port inside the docker network.
_QUICK_METRICS_URL = "http://cloudflared-quick:2000/quicktunnel"


class PublicConfig(BaseModel):
    tunnel_mode: str  # "quick" | "named" | "lan"
    public_webhook_base: str | None = None
    ephemeral: bool = False  # True for quick mode — URL changes on restart


async def _try_quick_tunnel() -> str | None:
    """Ask cloudflared (quick mode) for the trycloudflare hostname.

    Returns the full ``https://<hostname>`` URL or None if the metrics
    endpoint isn't reachable (no quick-mode container) or hasn't yet
    learned a hostname.
    """
    try:
        # Short timeout — cloudflared-quick is on the same docker network,
        # so any successful probe completes in milliseconds. We poll this
        # endpoint every 2s while the page is loading, so a long timeout
        # in LAN mode (where the host isn't even resolvable) would stall
        # the UI.
        async with httpx.AsyncClient(timeout=0.5) as client:
            r = await client.get(_QUICK_METRICS_URL)
        if r.status_code != 200:
            return None
        data = r.json()
        hostname = data.get("hostname")
        if isinstance(hostname, str) and hostname:
            return f"https://{hostname}"
    except Exception:
        return None
    return None


@router.get("", response_model=PublicConfig)
async def public_config() -> PublicConfig:
    quick_url = await _try_quick_tunnel()
    if quick_url:
        return PublicConfig(
            tunnel_mode="quick",
            public_webhook_base=quick_url,
            ephemeral=True,
        )
    if settings.public_webhook_base:
        return PublicConfig(
            tunnel_mode="named",
            public_webhook_base=settings.public_webhook_base,
            ephemeral=False,
        )
    return PublicConfig(tunnel_mode="lan", public_webhook_base=None, ephemeral=False)
