"""Watching a Verkada camera live, in the browser, without handing the
browser a Verkada credential.

Verkada already serves live video: the footage stream endpoint with no
time window is the live edge, and ``footage.stream_url`` builds it. What
it does not do is serve it to a browser. Two things get in the way, and
both are solved the same way.

**The URL carries a token.** The stream key is a JWT good for ten
minutes and for the whole org's footage -- not just this camera. Playing
the URL directly in a ``<video>`` would put it in the page source, the
network panel, and any bug report containing either. So nothing outside
this process ever sees it: ffmpeg is the only reader, and the browser is
given re-encoded segments from local disk.

**The codec is not a given.** Verkada can serve HEVC, which Chrome and
Firefox will not play through MSE. Re-encoding to H.264/AAC makes the
question moot rather than betting on what a particular camera returns.

The cost of that is a transcode per camera being watched, which is why
sessions are capped, shared between viewers of the same camera, and
reaped the moment nobody is asking for segments. An ffmpeg nobody is
watching is pure heat.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from app.connectors.verkada import footage


logger = logging.getLogger(__name__)

HLS_ROOT = Path(os.environ.get("LIVE_HLS_DIR", "/app/data/live"))

# Concurrent transcodes. Each is a 720p H.264 encode, so this is a CPU
# budget rather than a product decision -- raise it on a bigger host.
MAX_SESSIONS = int(os.environ.get("LIVE_MAX_SESSIONS", "3"))

# How long a session survives with nobody fetching from it. A player
# pulls the playlist every segment duration or so, so anything past a
# few segments means the tab is gone.
IDLE_SEC = float(os.environ.get("LIVE_IDLE_SEC", "25"))

SEGMENT_SEC = 2
WINDOW_SEGMENTS = 6
TARGET_HEIGHT = int(os.environ.get("LIVE_HEIGHT", "720"))

# A run this short did not stream anything; it failed. Used to tell
# "the stream key expired after nine minutes" (restart it) from "this
# camera cannot be opened at all" (say so and stop).
MIN_USEFUL_RUN_SEC = 4.0
MAX_FAST_FAILURES = 3

_SEG_RE = re.compile(r"seg(\d+)\.ts$")

# The flags every run gets. discont_start is appended on a restart only.
_HLS_FLAGS = "delete_segments+append_list+omit_endlist+independent_segments"


class LiveError(RuntimeError):
    pass


class LiveSession:
    """One camera, one ffmpeg, however many viewers."""

    def __init__(
        self,
        *,
        camera_id: str,
        name: str,
        api_key: str,
        org_id: str,
        base_url: str | None,
    ) -> None:
        self.id = uuid.uuid4().hex
        self.camera_id = camera_id
        self.name = name
        self.started_at = time.time()
        self.last_seen = time.time()
        self.error: str | None = None
        self.restarts = 0
        self.dir = HLS_ROOT / self.id
        self._api_key = api_key
        self._org_id = org_id
        self._base_url = base_url
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None
        self._stopping = False
        self._next_segment = 0

    # ------------------------------------------------------------ state
    @property
    def playlist_path(self) -> Path:
        return self.dir / "index.m3u8"

    @property
    def ready(self) -> bool:
        return self.playlist_path.exists()

    def touch(self) -> None:
        self.last_seen = time.time()

    def public(self) -> dict[str, Any]:
        return {
            "session_id": self.id,
            "camera_id": self.camera_id,
            "name": self.name,
            "ready": self.ready,
            "error": self.error,
            "restarts": self.restarts,
            "started_at": self.started_at,
            "idle_sec": round(time.time() - self.last_seen, 1),
            "playlist_url": f"/api/live/{self.id}/index.m3u8",
        }

    # ------------------------------------------------------------ ffmpeg
    def _command(self, url: str) -> list[str]:
        return [
            "ffmpeg", "-nostdin", "-y",
            "-loglevel", "error",
            # A stalled read should end the run so the supervisor can
            # reconnect, rather than parking a live camera on "loading".
            "-rw_timeout", "15000000",
            "-i", url,
            "-vf", f"scale=-2:{TARGET_HEIGHT}",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-tune", "zerolatency",
            "-profile:v", "main",
            "-pix_fmt", "yuv420p",
            "-crf", "26",
            # Segments can only be cut on a keyframe. Asking for one every
            # SEGMENT_SEC is what keeps segment length honest -- relying on
            # the source's own GOP produces segments of whatever length it
            # felt like, and the player's buffer estimate goes with it.
            "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_SEC})",
            # No -map: a camera with no microphone has no audio stream, and
            # naming one that does not exist is a hard error rather than a
            # silent track drop.
            "-c:a", "aac", "-b:a", "64k", "-ac", "1",
            "-f", "hls",
            "-hls_time", str(SEGMENT_SEC),
            "-hls_list_size", str(WINDOW_SEGMENTS),
            "-hls_delete_threshold", "2",
            # discont_start marks the restart boundary. Re-encoding starts
            # its timestamps over, and a player that meets a timestamp
            # jump with no discontinuity tag stalls -- which would have
            # meant every stream dying ten minutes in, when the key
            # rotates, rather than at a time anyone would connect to it.
            #
            # Only on a restart, though. On the first run there is
            # nothing to be discontinuous from, and asking for it anyway
            # put two EXT-X-DISCONTINUITY tags at the top of every new
            # playlist -- one of them above EXT-X-INDEPENDENT-SEGMENTS,
            # in the header, where a segment tag has no business being.
            # They sit there for the twenty seconds it takes the window
            # to roll past the first segments, which is exactly the
            # window in which a player attaches.
            "-hls_flags",
            _HLS_FLAGS + ("+discont_start" if self._next_segment else ""),
            "-hls_segment_type", "mpegts",
            # Numbering continues across a restart. Starting over at zero
            # would write a segment the player has already fetched and
            # cached, and it would play the old one.
            "-start_number", str(self._next_segment),
            # Relative, and ffmpeg is run from the session directory.
            # Segment names are written into the playlist verbatim, so an
            # absolute path here becomes an absolute URL in the browser --
            # which resolves against our own origin and 404s.
            "-hls_segment_filename", "seg%06d.ts",
            "index.m3u8",
        ]

    async def _run_once(self) -> tuple[float, str]:
        """One ffmpeg lifetime. Returns (seconds it ran, last stderr)."""
        key = await footage.get_stream_key(
            self._api_key, self._org_id, base_url=self._base_url
        )
        url = footage.stream_url(
            base_url=self._base_url or "",
            org_id=self._org_id,
            camera_id=self.camera_id,
            jwt=key,
        )
        started = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            *self._command(url),
            cwd=str(self.dir),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        self._proc = proc
        _, err = await proc.communicate()
        self._proc = None
        # ffmpeg echoes the input URL in its errors, and the input URL is
        # the token. Never let this reach a log or a response unredacted.
        noise = footage.redact(err.decode("utf-8", "replace").strip())
        self._advance_segment_counter()
        return time.monotonic() - started, noise

    def _advance_segment_counter(self) -> None:
        highest = -1
        try:
            for child in self.dir.iterdir():
                m = _SEG_RE.search(child.name)
                if m:
                    highest = max(highest, int(m.group(1)))
        except OSError:
            return
        self._next_segment = highest + 1

    async def _supervise(self) -> None:
        """Keep a stream up for as long as somebody is watching.

        Restarting is the normal case, not the failure case: the stream
        key expires after ten minutes and takes ffmpeg with it. What
        separates that from a broken camera is how long the run lasted.
        """
        fast_failures = 0
        while not self._stopping:
            try:
                ran, noise = await self._run_once()
            except footage.FootageError as e:
                self.error = str(e)
                logger.warning("live %s: %s", self.camera_id, self.error)
                return
            except Exception as e:  # noqa: BLE001
                self.error = f"could not start the stream: {e}"
                logger.exception("live %s failed to start", self.camera_id)
                return
            if self._stopping:
                return
            if ran >= MIN_USEFUL_RUN_SEC:
                fast_failures = 0
                self.restarts += 1
                self.error = None
                logger.info(
                    "live %s: stream ended after %.0fs, reconnecting",
                    self.camera_id, ran,
                )
                continue
            fast_failures += 1
            if fast_failures >= MAX_FAST_FAILURES:
                self.error = (
                    noise[:300]
                    or "the camera's live stream could not be opened — "
                    "it may be offline"
                )
                logger.warning(
                    "live %s: gave up after %d immediate failures: %s",
                    self.camera_id, fast_failures, self.error,
                )
                return
            await asyncio.sleep(1.5 * fast_failures)

    # ----------------------------------------------------------- control
    async def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self._task = asyncio.create_task(self._supervise())

    async def stop(self) -> None:
        self._stopping = True
        proc = self._proc
        if proc and proc.returncode is None:
            proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError):
                pass
        task = self._task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        shutil.rmtree(self.dir, ignore_errors=True)


class LiveManager:
    def __init__(self) -> None:
        self._sessions: dict[str, LiveSession] = {}
        self._lock = asyncio.Lock()
        self._reaper: asyncio.Task | None = None

    async def open(
        self,
        *,
        camera_id: str,
        name: str,
        api_key: str,
        org_id: str,
        base_url: str | None,
    ) -> LiveSession:
        """A session for this camera, reusing one if it is already up.

        Two people watching the front door is one transcode, not two.
        """
        async with self._lock:
            for s in self._sessions.values():
                if s.camera_id == camera_id and s.error is None:
                    s.touch()
                    return s
            # A previous attempt at this camera failed. Retire it here
            # rather than leaving it for the reaper: "try again" should
            # not mean "wait out the idle timer first", and a dead
            # session still occupies a slot in the listing.
            dead = [
                s for s in self._sessions.values()
                if s.camera_id == camera_id and s.error is not None
            ]
            for s in dead:
                self._sessions.pop(s.id, None)
                await s.stop()
            live = [s for s in self._sessions.values() if s.error is None]
            if len(live) >= MAX_SESSIONS:
                raise LiveError(
                    f"{MAX_SESSIONS} cameras are already streaming, which is "
                    "all this host is configured to transcode at once. Close "
                    "one and try again."
                )
            session = LiveSession(
                camera_id=camera_id,
                name=name,
                api_key=api_key,
                org_id=org_id,
                base_url=base_url,
            )
            self._sessions[session.id] = session
            await session.start()
            if self._reaper is None or self._reaper.done():
                self._reaper = asyncio.create_task(self._reap_forever())
            return session

    def get(self, session_id: str) -> LiveSession | None:
        return self._sessions.get(session_id)

    def all(self) -> list[LiveSession]:
        return list(self._sessions.values())

    async def close(self, session_id: str) -> bool:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        await session.stop()
        return True

    async def _reap_forever(self) -> None:
        while True:
            await asyncio.sleep(5)
            now = time.time()
            async with self._lock:
                stale = [
                    s for s in self._sessions.values()
                    if now - s.last_seen > IDLE_SEC
                ]
                for s in stale:
                    self._sessions.pop(s.id, None)
            for s in stale:
                logger.info("live %s: no viewers, stopping", s.camera_id)
                await s.stop()
            if not self._sessions:
                return


manager = LiveManager()


def clear_stale_dirs() -> None:
    """Anything under the HLS root at boot is from a process that died.

    Segments are worthless the moment the encoder writing them stops, so
    there is nothing to salvage -- only disk to reclaim.
    """
    try:
        if not HLS_ROOT.exists():
            return
        for child in HLS_ROOT.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
    except OSError as e:
        logger.warning("could not clear stale live dirs: %s", e)
