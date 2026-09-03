"""Whether vFusion is the broker, or is only configuring cameras for one.

Two deployments look nothing alike:

* **Built in.** vFusion runs mosquitto, generates the CA, and cameras
  publish here. It can therefore show what it receives — the live view,
  the noise filter and the history all depend on being the destination.

* **External.** Somebody already has a broker. vFusion cannot generate a
  certificate for it (the camera needs the CA that signs *that* broker's
  cert, which we do not hold) and cannot invent credentials for it, so
  both are supplied. It pushes the config to cameras and stops there;
  the data goes somewhere else, and pretending otherwise would show an
  empty live view with no explanation.

Kept in a file next to the other MQTT settings, for the same reason:
this is deployment configuration, not a record, and it should not need a
migration to change.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Literal


logger = logging.getLogger(__name__)

STORE_PATH = Path(os.environ.get("MQTT_MODE_FILE", "/app/data/mqtt/broker-mode.json"))

Mode = Literal["builtin", "external"]

_lock = asyncio.Lock()


def _blank() -> dict[str, Any]:
    return {
        "mode": "builtin",
        "host": "",
        "port": 443,
        "username": "",
        "password": "",
        "broker_cert": "",
    }


def get() -> dict[str, Any]:
    try:
        data = json.loads(STORE_PATH.read_text())
    except FileNotFoundError:
        return _blank()
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("broker mode unreadable (%s); assuming built in", e)
        return _blank()
    if not isinstance(data, dict):
        return _blank()
    merged = _blank()
    merged.update({k: data[k] for k in merged if k in data})
    if merged["mode"] not in ("builtin", "external"):
        merged["mode"] = "builtin"
    return merged


def public() -> dict[str, Any]:
    """Same, without the password — this one is safe to render."""
    current = get()
    return {
        **{k: v for k, v in current.items() if k != "password"},
        "password_set": bool(current.get("password")),
        # The certificate is not secret, but it is 1.5KB of base64 and
        # nothing in the UI wants to display it.
        "broker_cert": "",
        "cert_present": bool(current.get("broker_cert")),
    }


async def put(entry: dict[str, Any]) -> dict[str, Any]:
    async with _lock:
        current = get()
        current.update(entry)
        # An empty password on an update means "leave it alone" rather
        # than "clear it" — the UI cannot show it back to re-submit.
        if not entry.get("password"):
            current["password"] = get().get("password", "")
        if not entry.get("broker_cert"):
            current["broker_cert"] = get().get("broker_cert", "")
        try:
            STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = STORE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(current))
            tmp.replace(STORE_PATH)
            os.chmod(STORE_PATH, 0o600)
        except OSError as e:
            logger.warning("could not persist broker mode: %s", e)
    return public()


def is_external() -> bool:
    return get().get("mode") == "external"


def camera_target() -> dict[str, str]:
    """What to push to a camera: address, credentials and CA.

    Built in, these come from the generated certificate and stored
    credentials. External, they are whatever was entered — vFusion has no
    way to derive them.
    """
    current = get()
    if current["mode"] != "external":
        from app.mqtt import provision

        creds = provision.load_credentials() or {}
        host = provision.broker_host() or ""
        return {
            "broker_host_port": f"{host}:443" if host else "",
            "client_username": creds.get("username", ""),
            "client_password": creds.get("password", ""),
            "broker_cert": (
                provision.CA_PATH.read_text() if provision.CA_PATH.is_file() else ""
            ),
        }
    return {
        "broker_host_port": (
            f"{current['host']}:{current['port']}" if current.get("host") else ""
        ),
        "client_username": str(current.get("username") or ""),
        "client_password": str(current.get("password") or ""),
        "broker_cert": str(current.get("broker_cert") or ""),
    }
