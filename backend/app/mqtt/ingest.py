"""Subscribe to the camera object-position firehose and keep live track state.

Verkada cameras publish bounding boxes to ``/occupancy_trend/tracks`` at
roughly 8 messages per second per tracked object. Two properties of that
stream shape everything here:

* **There is no "object left" message.** A track simply stops being
  mentioned. Anything counting these has to expire tracks on a timer or it
  counts up forever and never returns to zero.
* **It is a firehose.** The raw stream stays in this process; consumers get
  a derived snapshot, not the messages.

State is in-memory on purpose. It describes what is in front of a camera
*right now* -- a restart losing it is correct, and persisting 8 Hz of
bounding boxes would be a lot of writes for data that is worthless three
seconds later.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any


logger = logging.getLogger(__name__)

TOPIC = "/occupancy_trend/tracks"

# How long a track survives without a new detection. The camera never says
# "gone", so this is the only thing that clears the frame.
TRACK_TIMEOUT_SEC = float(os.environ.get("MQTT_TRACK_TIMEOUT_SEC", "3.0"))

OBJECT_TYPES = ("person", "animal", "vehicle")


@dataclass
class Track:
    obj_id: str
    type: str
    cx: float
    cy: float
    w: float
    h: float
    last_seen: float
    first_seen: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "obj_id": self.obj_id,
            "type": self.type,
            "cx": round(self.cx, 4),
            "cy": round(self.cy, 4),
            "w": round(self.w, 4),
            "h": round(self.h, 4),
            "age": round(time.monotonic() - self.first_seen, 2),
        }


@dataclass
class CameraState:
    tracks: dict[str, Track] = field(default_factory=dict)
    last_message: float = 0.0
    message_count: int = 0
    # Bumped on every message so SSE clients can push immediately rather
    # than poll — latency here is the whole point of the feature.
    revision: int = 0


class Ingest:
    """Holds live track state for every camera publishing to the broker."""

    def __init__(self) -> None:
        self.cameras: dict[str, CameraState] = {}
        self.connected = False
        self.last_error: str | None = None
        self.started_at: float | None = None
        self.total_messages = 0
        self._event = asyncio.Event()
        self._task: asyncio.Task | None = None

    # ---- consumer side -------------------------------------------------

    def snapshot(self, camera_id: str | None = None) -> dict[str, Any]:
        """Current objects per camera, with expired tracks dropped."""
        now = time.monotonic()
        out: dict[str, Any] = {}
        for cid, state in self.cameras.items():
            if camera_id and cid != camera_id:
                continue
            live = [
                t for t in state.tracks.values()
                if now - t.last_seen <= TRACK_TIMEOUT_SEC
            ]
            counts = {kind: sum(1 for t in live if t.type == kind) for kind in OBJECT_TYPES}
            out[cid] = {
                "objects": [t.as_dict() for t in live],
                "counts": counts,
                "total": len(live),
                "age_sec": round(now - state.last_message, 2) if state.last_message else None,
                "message_count": state.message_count,
                "revision": state.revision,
            }
        return out

    async def wait_for_change(self, timeout: float) -> None:
        """Block until a message lands, or ``timeout`` elapses.

        The timeout is what makes tracks visibly expire on a quiet camera:
        without it a stream would freeze on the last frame that had objects
        in it rather than emptying out.
        """
        try:
            await asyncio.wait_for(self._event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return
        finally:
            self._event.clear()

    def status(self) -> dict[str, Any]:
        return {
            "connected": self.connected,
            "enabled": enabled(),
            "host": os.environ.get("MQTT_HOST", "mqtt-broker"),
            "topic": TOPIC,
            "last_error": self.last_error,
            "uptime_sec": (
                round(time.monotonic() - self.started_at, 1) if self.started_at else None
            ),
            "total_messages": self.total_messages,
            "cameras": sorted(self.cameras),
            "track_timeout_sec": TRACK_TIMEOUT_SEC,
        }

    # ---- producer side -------------------------------------------------

    def handle(self, payload: bytes) -> None:
        try:
            msg = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(msg, dict):
            return
        camera_id = msg.get("camera_id")
        objects = msg.get("objects")
        if not isinstance(camera_id, str) or not isinstance(objects, list):
            return

        now = time.monotonic()
        state = self.cameras.setdefault(camera_id, CameraState())
        state.last_message = now
        state.message_count += 1
        state.revision += 1
        self.total_messages += 1

        for obj in objects:
            if not isinstance(obj, dict):
                continue
            detections = obj.get("detections")
            if not isinstance(detections, list) or not detections:
                continue
            # A message carries a short trajectory; the last box is where
            # the object is now, which is all a live view needs.
            last = detections[-1]
            if not isinstance(last, dict):
                continue
            try:
                x1 = float(last["x1"]); y1 = float(last["y1"])
                x2 = float(last["x2"]); y2 = float(last["y2"])
            except (KeyError, TypeError, ValueError):
                continue
            obj_id = str(obj.get("obj_id", ""))
            if not obj_id:
                continue
            existing = state.tracks.get(obj_id)
            state.tracks[obj_id] = Track(
                obj_id=obj_id,
                type=str(obj.get("type") or "unknown"),
                cx=(x1 + x2) / 2,
                cy=(y1 + y2) / 2,
                w=abs(x2 - x1),
                h=abs(y2 - y1),
                last_seen=now,
                first_seen=existing.first_seen if existing else now,
            )

        # Drop long-dead tracks so a busy camera's dict doesn't grow all day.
        cutoff = now - (TRACK_TIMEOUT_SEC * 4)
        for obj_id in [k for k, t in state.tracks.items() if t.last_seen < cutoff]:
            del state.tracks[obj_id]

        self._event.set()

    # ---- lifecycle -----------------------------------------------------

    async def run(self) -> None:
        """Reconnecting subscribe loop. Never raises into the app."""
        import aiomqtt

        from app.mqtt import provision

        host = os.environ.get("MQTT_HOST", "mqtt-broker")
        port = int(os.environ.get("MQTT_PORT", "1883"))
        # Stored credentials win over env: setup generates them, and an
        # operator who never sees the password cannot paste a stale one
        # into .env and wonder why auth fails.
        stored = provision.load_credentials()
        username = (stored or {}).get("username") or os.environ.get("MQTT_USERNAME") or None
        password = (stored or {}).get("password") or os.environ.get("MQTT_PASSWORD") or None
        backoff = 1.0
        self.started_at = time.monotonic()

        while True:
            try:
                async with aiomqtt.Client(
                    hostname=host, port=port, username=username, password=password
                ) as client:
                    self.connected = True
                    self.last_error = None
                    backoff = 1.0
                    logger.info("mqtt ingest connected to %s:%s", host, port)
                    await client.subscribe(TOPIC)
                    async for message in client.messages:
                        self.handle(bytes(message.payload))
            except asyncio.CancelledError:
                self.connected = False
                raise
            except Exception as e:
                self.connected = False
                self.last_error = _explain(e, host)
                logger.warning("mqtt ingest disconnected (%s); retry in %.0fs", e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self.run())

    async def restart(self) -> None:
        """Pick up newly generated credentials without a container restart."""
        await self.stop()
        if enabled():
            self.start()

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None


def _explain(e: Exception, host: str) -> str:
    """Turn transport errors into the thing to actually go do.

    "[Errno -2] Name or service not known" is a correct and useless
    description of the broker container not being up yet -- the hostname
    only resolves once it exists on the docker network.
    """
    text = str(e)
    if "Name or service not known" in text or "Temporary failure in name resolution" in text:
        return (
            f"Broker {host!r} does not resolve — the container is not running. "
            "Either it was never started (docker compose --profile mqtt up -d) or "
            "it started and exited; check with: docker compose logs mqtt-broker"
        )
    if "Connection refused" in text:
        return f"Broker {host!r} is resolving but refusing connections — is mosquitto healthy?"
    if "not authorised" in text.lower() or "not authorized" in text.lower():
        return (
            "Broker rejected the credentials. Restart it so it re-reads the "
            "password file: docker compose restart mqtt-broker"
        )
    return f"{type(e).__name__}: {e}"


def enabled() -> bool:
    """Whether the ingest loop should be running.

    Generating broker credentials is the opt-in. Requiring a separate
    MQTT_INGEST_ENABLED on top of that meant setup could complete in the
    UI and quietly do nothing, which is the sort of second switch that
    only ever gets found by asking why nothing happened.
    """
    override = os.environ.get("MQTT_INGEST_ENABLED", "").strip().lower()
    if override in ("0", "false", "no"):
        return False
    if override in ("1", "true", "yes"):
        return True

    from app.mqtt import provision

    return provision.load_credentials() is not None


ingest = Ingest()
