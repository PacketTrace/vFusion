"""A demo that runs: footage on the wire, Helix events that match it.

The Connector records what the virtual camera sends, stamped when it
arrives. So footage at time T is whatever was streaming at T, and there
is no way to give a backfilled event a matching picture. The existing
Helix seeder drops a week of history instantly because it does not care
about video; this one cannot, and therefore runs forward in real time.

The loop is simple. An ambient clip holds the stream between events. On
a schedule, an event clip jumps the queue; the moment its first frame
goes out the pump reports the wall-clock, a row is generated from the
template's spec, and a Helix event is posted stamped inside that window.

**The offset is the whole thing.** Between ffmpeg emitting a frame and
the Connector having it on disk there is real latency — encoder, RTSP,
the Connector's own buffering — and if the event lands outside the clip
it points at an empty counter, which is worse than no demo at all. So
the offset is a setting rather than a constant, it defaults to the
middle of the clip so there is room to be wrong in both directions, and
every run records what it used next to what it produced.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

from app.connectors.verkada.client import VerkadaClient
from app.helixdemo import generate as helix_generate


logger = logging.getLogger(__name__)

HELIX_PATH = "/cameras/v1/video_tagging/event"

# Where inside the clip to stamp the event, before the offset is applied.
# The middle, deliberately: it leaves the most slack on both sides for a
# latency estimate that is wrong.
DEFAULT_MARK_FRACTION = 0.5

# How far the stream is behind the encoder, in seconds. A starting guess
# — the point of exposing it is that it gets corrected by looking.
DEFAULT_OFFSET_SEC = 3.0


class Run:
    """One live demo. Owns its task; nothing here outlives a stop."""

    def __init__(
        self,
        *,
        client: VerkadaClient,
        org_id: str | None,
        camera_id: str,
        event_type_uid: str,
        spec: dict[str, Any],
        event_clip: dict[str, Any],
        ambient_clip: dict[str, Any] | None,
        interval_sec: int,
        count: int,
        offset_sec: float,
        clip_seconds: float,
        pump: Any,
    ) -> None:
        self.client = client
        self.org_id = org_id
        self.camera_id = camera_id
        self.event_type_uid = event_type_uid
        self.spec = spec
        self.event_clip = event_clip
        self.ambient_clip = ambient_clip
        self.interval_sec = max(15, interval_sec)
        self.count = max(1, count)
        self.offset_sec = offset_sec
        self.clip_seconds = max(1.0, clip_seconds)
        self.pump = pump

        self.status = "idle"
        self.posted: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self.started_at: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._rng = random.Random()
        # Set by the pump callback when the event clip actually starts.
        self._clip_started: asyncio.Future[float] | None = None

    # -- pump plumbing ----------------------------------------------------

    def _on_source_start(self, item: dict[str, Any] | None, at: float) -> None:
        fut = self._clip_started
        if fut is None or fut.done():
            return
        if item and item.get("id") == self.event_clip.get("id"):
            fut.get_loop().call_soon_threadsafe(fut.set_result, at)

    # -- the run ----------------------------------------------------------

    async def _post(self, at_epoch: float) -> None:
        # The posting time, not "now": a spec with timestamp-derived
        # fields (a shift's day, a clock-in time) has to agree with the
        # time_ms this event is about to carry.
        row = helix_generate.build_row(
            self._rng,
            self.spec.get("fields") or {},
            datetime.fromtimestamp(at_epoch, timezone.utc),
        )
        payload = {
            "camera_id": self.camera_id,
            "event_type_uid": self.event_type_uid,
            "time_ms": int(at_epoch * 1000),
            "attributes": row,
        }
        try:
            result = await self.client.request(
                method="POST",
                path=HELIX_PATH,
                query={"org_id": self.org_id} if self.org_id else None,
                json_body=payload,
            )
        except Exception as e:  # noqa: BLE001
            self.errors.append(str(e)[:200])
            return
        code = int(result.get("status_code") or 500)
        if code >= 400:
            self.errors.append(f"{code}: {result.get('body')!r}")
            return
        self.posted.append(
            {
                "at": datetime.fromtimestamp(at_epoch, tz=timezone.utc).isoformat(),
                "epoch": at_epoch,
                "attributes": row,
            }
        )

    async def _cycle(self) -> None:
        loop = asyncio.get_running_loop()
        self._clip_started = loop.create_future()
        self.pump.play_now(self.event_clip)
        try:
            # If the clip never starts, the sequencer must not hang: a
            # stuck pump should stop the run, not freeze it.
            started = await asyncio.wait_for(self._clip_started, timeout=90)
        except asyncio.TimeoutError:
            self.errors.append("the event clip never started playing")
            return
        finally:
            self._clip_started = None

        # Stamp inside the clip, then push forward by however far the
        # recording lags the encoder.
        mark = started + self.clip_seconds * DEFAULT_MARK_FRACTION + self.offset_sec
        await self._post(mark)

    async def _loop(self) -> None:
        self.status = "running"
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.pump.on_source_start(self._on_source_start)
        try:
            for i in range(self.count):
                if self.status != "running":
                    break
                await self._cycle()
                if i < self.count - 1:
                    await asyncio.sleep(self.interval_sec)
            if self.status == "running":
                self.status = "done"
        except asyncio.CancelledError:
            self.status = "stopped"
            raise
        except Exception as e:  # noqa: BLE001
            self.status = "failed"
            self.errors.append(str(e)[:300])
            logger.exception("demo sequencer failed")
        finally:
            self.pump.on_source_start(None)

    def start(self) -> None:
        # Held, because asyncio keeps only a weak reference and a
        # collected sequencer would stop mid-demo with no trace.
        self._task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        self.status = "stopped"
        if self._task and not self._task.done():
            self._task.cancel()

    def state(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "started_at": self.started_at,
            "posted": len(self.posted),
            "requested": self.count,
            "interval_sec": self.interval_sec,
            "offset_sec": self.offset_sec,
            "clip_seconds": self.clip_seconds,
            "events": self.posted[-10:],
            "errors": self.errors[-5:],
            "camera_id": self.camera_id,
        }


# One at a time. Two sequencers would fight over the pump's single
# priority slot and produce events pointing at each other's footage.
_current: Run | None = None


def current() -> Run | None:
    return _current


def set_current(run: Run | None) -> None:
    global _current
    _current = run
