"""A virtual camera Verkada's Command Connector can pull from.

The Connector adds a third-party camera by RTSP URL and then expects
that URL to keep answering. Not "answer when there is something to
show" — keep answering. A stream that stops between clips gets the
camera marked offline, and a camera that flaps is worse than one that
was never added.

So the shape of this feature is not "serve a clip over RTSP". It is
"hold one unbroken stream open forever and change what is inside it".
Everything else here follows from that.

Geometry is fixed for the life of the stream, because it is baked into
the SDP the Connector negotiated when it connected. Uploads are scaled
and padded to fit rather than the stream adapting to them; changing
these constants means re-adding the camera in Command.

State is a file on the ``webhook_assets`` volume rather than a table:
it is deployment configuration, it changes when someone flips a switch,
and it is not worth a schema migration.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

STORE_PATH = Path(os.environ.get("RTSP_STATE_FILE", "/app/data/rtsp/state.json"))

# Where the generated MediaMTX config lands. Bind-mounted from the repo
# so the sidecar can read it, exactly as the MQTT broker's config is.
CONFIG_PATH = Path(os.environ.get("RTSP_CONFIG_FILE", "/app/rtsp-host/mediamtx.yml"))

# The stream. 1080p24: enough detail to be worth recording, and 24 is a
# frame rate real footage actually arrives at, so most uploads pass
# through without the fps filter inventing or dropping frames.
WIDTH = int(os.environ.get("RTSP_WIDTH", "1920"))
HEIGHT = int(os.environ.get("RTSP_HEIGHT", "1080"))
FPS = int(os.environ.get("RTSP_FPS", "24"))
BITRATE = os.environ.get("RTSP_BITRATE", "3000k")

# Where the publisher connects. Inside the compose network the sidecar
# answers to its service name; what we hand Verkada is a LAN address,
# which is a different question and lives in the state file.
INTERNAL_HOST = os.environ.get("RTSP_INTERNAL_HOST", "rtsp-server")
PORT = int(os.environ.get("RTSP_PORT", "8554"))

# What the Connector dials, which is not always what the server listens
# on. 8554 is the standard RTSP port and therefore the one already taken
# on any host running another MediaMTX — an Echo relay, a NVR bridge,
# anything. Remap the published port and set this to match, and the URL
# handed to Verkada follows.
PUBLIC_PORT = int(os.environ.get("RTSP_PUBLIC_PORT", str(PORT)))

# One camera today. The store is keyed by stream name so adding a second
# is a row here and another pump, not a redesign.
DEFAULT_STREAM = "cam1"

_lock = asyncio.Lock()


def _blank() -> dict[str, Any]:
    return {
        "enabled": False,
        "stream": DEFAULT_STREAM,
        # What the operator types into Command. Not derivable: the
        # Connector reaches this host across the LAN, and the container
        # has no idea what address that is.
        "advertise_host": "",
        "read_username": "",
        "read_password": "",
        # The publisher's own credentials, never shown. Separate from the
        # read user so the URL handed to Verkada cannot also publish to
        # the path it is watching.
        "publish_username": "vfusion",
        "publish_password": "",
        "loop": False,
    }


def get() -> dict[str, Any]:
    try:
        data = json.loads(STORE_PATH.read_text())
    except FileNotFoundError:
        return _blank()
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("rtsp state unreadable (%s); assuming off", e)
        return _blank()
    if not isinstance(data, dict):
        return _blank()
    merged = _blank()
    merged.update({k: data[k] for k in merged if k in data})
    return merged


def public() -> dict[str, Any]:
    """Everything except the publisher's password.

    The read password *is* returned: it is the thing being handed to
    Verkada, and a credential you cannot read is a credential you cannot
    use. It is generated here, shown once in a field with a copy button,
    and regenerating it is one click.
    """
    current = get()
    return {
        **{k: v for k, v in current.items() if k != "publish_password"},
        "url": url_for(current),
        "width": WIDTH,
        "height": HEIGHT,
        "fps": FPS,
        "port": PUBLIC_PORT,
    }


def url_for(state: dict[str, Any] | None = None) -> str:
    """The URL to paste into Add Cameras, or "" if we cannot form one."""
    current = state or get()
    host = str(current.get("advertise_host") or "").strip()
    if not host:
        return ""
    return f"rtsp://{host}:{PUBLIC_PORT}/{current.get('stream') or DEFAULT_STREAM}"


def publish_url(state: dict[str, Any] | None = None) -> str:
    """Where the encoder pushes, inside the compose network."""
    current = state or get()
    user = current.get("publish_username") or "vfusion"
    pw = current.get("publish_password") or ""
    stream = current.get("stream") or DEFAULT_STREAM
    return f"rtsp://{user}:{pw}@{INTERNAL_HOST}:{PORT}/{stream}"


def _password() -> str:
    # URL-safe by construction: this ends up inside an rtsp:// URL that
    # someone pastes into a form, and a password needing percent-encoding
    # there is a support ticket waiting to happen.
    return secrets.token_urlsafe(18).replace("-", "").replace("_", "")[:24]


async def put(entry: dict[str, Any]) -> dict[str, Any]:
    async with _lock:
        current = get()
        current.update({k: v for k, v in entry.items() if k in current})
        # Credentials are generated, never supplied. Fill any that are
        # missing rather than making "turn it on" a two-step affair.
        if not current["read_username"]:
            current["read_username"] = "verkada"
        if not current["read_password"]:
            current["read_password"] = _password()
        if not current["publish_password"]:
            current["publish_password"] = _password()
        _write(current)
    return public()


async def rotate_read_password() -> dict[str, Any]:
    async with _lock:
        current = get()
        current["read_password"] = _password()
        _write(current)
    return public()


def _write(current: dict[str, Any]) -> None:
    try:
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STORE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(current))
        tmp.replace(STORE_PATH)
        os.chmod(STORE_PATH, 0o600)
    except OSError as e:
        logger.warning("could not persist rtsp state: %s", e)
