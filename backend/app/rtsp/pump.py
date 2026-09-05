"""One stream that never stops, whatever is playing inside it.

The obvious way to build this is to run ffmpeg per clip, pointed at the
RTSP server. It works, and it is wrong: every clip boundary tears the
session down and builds a new one, and a Verkada Command Connector
watching that sees the camera go offline and come back a few seconds
later, over and over.

So the encoder is a single long-lived process that is never restarted
between clips, and the thing that changes is what is being fed into it:

    source ffmpeg  ->  os.pipe()  ->  encoder ffmpeg  ->  RTSP publish
    (clip / standby)                 (never exits)

Two details make it hold together.

**The pipe outlives its writers.** The write end is held open by this
process for as long as the pump runs, and each source gets a duplicate
of it. When a clip finishes, its ffmpeg exits and closes its copy — but
ours is still open, so the encoder never sees EOF and never exits. Hand
the source the only writer and the whole thing collapses at the end of
the first clip.

**Every source is normalised before it gets there.** Scaled, padded,
frame-rate converted and pixel-format converted by the source's own
filter chain, so what arrives is always raw frames of exactly one
geometry. The encoder therefore has no idea a source changed, which is
precisely what makes the switch invisible downstream.

The bytes go decoder-to-encoder through the kernel; this process is not
in the frame path. At 1080p24 that is around 75 MB/s that never enters
Python.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from collections import deque
from typing import Any

from app.rtsp import mediamtx, queue, settings


logger = logging.getLogger(__name__)

# The font is in the image (fonts-dejavu-core). Named explicitly rather
# than left to fontconfig, which resolves differently on slim images and
# fails at run time rather than build time.
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# How long to wait before rebuilding the encoder after it dies. Long
# enough not to spin against a broker that is still starting, short
# enough that a restart of the RTSP server is a blip.
RESTART_DELAY_SEC = 3.0


class Pump:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._encoder: asyncio.subprocess.Process | None = None
        self._source: asyncio.subprocess.Process | None = None
        self._write_fd: int | None = None
        self._read_fd: int | None = None
        # A second pipe, for audio.
        #
        # The tempting alternative is one pipe carrying a container -- nut
        # or matroska -- with both streams in it. That breaks the thing
        # this whole design rests on: raw formats have no header, so one
        # source's output concatenates onto the previous one's and the
        # encoder never notices the join. A container writes a header per
        # source, and the second one arrives mid-stream as garbage.
        #
        # So: two headerless pipes, raw frames and raw PCM, both spliced
        # the same way.
        self._awrite_fd: int | None = None
        self._aread_fd: int | None = None
        self.running = False
        self.started_at: float | None = None
        self.now_playing: dict[str, Any] | None = None
        self.encoder_starts = 0
        self.last_error: str | None = None
        # ffmpeg says exactly why it failed and it says it on stderr.
        # This was going to DEVNULL, which turned every failure into a
        # bare exit code and made the page useless at the one moment it
        # most needed to be useful.
        self.log: deque[str] = deque(maxlen=40)
        self._log_task: asyncio.Task | None = None
        self._source_log_task: asyncio.Task | None = None
        # How long the pipe went unfed between one source exiting and the
        # next producing. The encoder timestamps by frame count, so a gap
        # is not dropped time -- it stalls and resumes, which downstream
        # is indistinguishable from a burst of lost packets.
        self._idle_since: float | None = None
        self.last_gap_ms: int | None = None
        self.worst_gap_ms: int | None = None

    # ---- lifecycle -----------------------------------------------------

    # Set by play_now / on_source_start. Declared here so the pump has
    # them from construction rather than growing attributes later.
    _priority: dict[str, Any] | None = None
    _on_start: Any = None
    # When the current source began, in wall-clock seconds. Distinct
    # from ``started_at``, which is the pump's own monotonic start and
    # is what uptime is measured against — conflating them broke uptime.
    source_started_at: float | None = None

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self.running = True
        self.started_at = time.monotonic()
        self.last_error = None
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self.running = False
        for proc in (self._source, self._encoder):
            await _kill(proc)
        self._source = None
        self._encoder = None
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        self._close_pipe()
        self.now_playing = None
        self.started_at = None

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "publishing": self._encoder is not None and self._encoder.returncode is None,
            "now_playing": self.now_playing,
            "uptime_sec": (
                round(time.monotonic() - self.started_at, 1)
                if self.started_at and time.monotonic() >= self.started_at
                else None
            ),
            "source_started_at": self.source_started_at,
            "encoder_starts": self.encoder_starts,
            "last_error": self.last_error,
            "log": list(self.log),
            "last_gap_ms": self.last_gap_ms,
            "worst_gap_ms": self.worst_gap_ms,
        }

    # ---- the loop ------------------------------------------------------

    async def _run(self) -> None:
        while self.running:
            try:
                await self._ensure_encoder()
                await self._play_next()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # never let the pump die on one bad clip
                self.last_error = str(e)
                logger.warning("rtsp pump: %s", e)
                await asyncio.sleep(1.0)

    async def _ensure_encoder(self) -> None:
        if self._encoder is not None and self._encoder.returncode is None:
            return
        if self._encoder is not None:
            # It exited. Usually the RTSP server went away underneath us.
            self.last_error = f"encoder exited with {self._encoder.returncode}"
            await asyncio.sleep(RESTART_DELAY_SEC)

        # A fresh pipe per encoder: the old one may hold frames the new
        # encoder would emit as a burst of stale video on reconnect. The
        # source goes with it — it is writing into an fd about to close.
        await _kill(self._source)
        self._source = None
        self._close_pipe()
        self._read_fd, self._write_fd = os.pipe()
        self._aread_fd, self._awrite_fd = os.pipe()
        # One process writes both pipes, and a pipe holds 64KB by default
        # while a 1080p frame is 3.1MB -- so the source is blocked on the
        # video pipe almost permanently, which is fine because the encoder
        # is draining it. What is not fine is the source blocking on the
        # *audio* pipe while the encoder is still draining video: then
        # both sides wait and nothing is ever published.
        #
        # A megabyte of PCM is about five seconds, which is far more
        # run-ahead than the interleave needs. Best effort: the cap is
        # /proc/sys/fs/pipe-max-size and a refusal is not worth failing
        # over.
        _widen(self._awrite_fd)

        state = settings.get()
        cmd = _encoder_cmd(
            settings.publish_url(state),
            settings.publish_url(state, settings.sub_stream(state)),
            settings.is_onvif(state),
            self._aread_fd,
        )
        # The command, once per encoder start. Reconstructing it from the
        # source to work out what ffmpeg was actually given is a step that
        # should not be necessary when the answer can just be recorded.
        # Credentials are in the publish URL, so it is logged with them
        # replaced rather than not logged.
        #
        # At warning level despite not being one: uvicorn leaves the root
        # logger at WARNING, so info from here goes nowhere. A diagnostic
        # that cannot be seen is the same as one that was not written --
        # which is the mistake this line exists to stop repeating.
        logger.warning("rtsp encoder: %s", " ".join(_redact(a) for a in cmd))
        self._encoder = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=self._read_fd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            # ffmpeg addresses the audio pipe as pipe:<fd>, so the number
            # has to survive into the child unchanged.
            pass_fds=(self._aread_fd,),
        )
        self.encoder_starts += 1
        # Drained, not just captured: an undrained stderr pipe fills at
        # 64KB and blocks the process writing into it.
        if self._log_task:
            self._log_task.cancel()
        self._log_task = asyncio.create_task(self._drain(self._encoder))
        # The child has its own copy now. Ours stays open only because
        # closing it would make a source's EOF reach the encoder.
        os.close(self._read_fd)
        self._read_fd = None

    async def _drain(self, proc: asyncio.subprocess.Process) -> None:
        """Keep the last few lines ffmpeg wrote, and keep the pipe empty.

        Read in chunks and split on carriage returns as well as newlines:
        ffmpeg ends each stats line with a bare \\r so it can overwrite
        itself on a terminal, and readline() would hold the whole run of
        them until some error happened to emit a newline.
        """
        if proc.stderr is None:
            return
        buffer = ""
        with contextlib.suppress(Exception):
            while True:
                chunk = await proc.stderr.read(4096)
                if not chunk:
                    return
                buffer += chunk.decode("utf-8", "replace")
                parts = buffer.replace("\r", "\n").split("\n")
                buffer = parts.pop()
                for line in (p.strip() for p in parts):
                    if not line:
                        continue
                    self.log.append(line)
                    logger.warning("ffmpeg: %s", line)
                    # A stats line is not a failure. Letting it land in
                    # last_error would put "frame=1234 fps=24 speed=1x"
                    # where the page says what went wrong.
                    if not line.startswith(("frame=", "size=")):
                        self.last_error = line

    def play_now(self, item: dict[str, Any]) -> None:
        """Jump this clip ahead of the queue at the next source change.

        One slot, not a list: the caller is a sequencer that plays one
        thing at a time and would rather its second request replace a
        stale first than sit behind it.
        """
        self._priority = item

    def on_source_start(self, fn: Any) -> None:
        """Called with (item, unix_seconds) as each source begins."""
        self._on_start = fn

    async def _play_next(self) -> None:
        # Cleared before the check, not inside standby: an upload landing
        # between "queue is empty" and "start waiting" would otherwise be
        # missed, and standby has no other reason to ever end.
        queue.arrived.clear()
        # The jump slot wins, and is consumed whether or not it plays
        # cleanly — a clip that fails should not be retried forever in
        # front of whatever the sequencer wanted next.
        item = self._priority
        self._priority = None
        if item is None:
            item = queue.next_pending()
        if item is None:
            await self._standby()
            return

        self.now_playing = {k: item[k] for k in ("id", "name", "kind") if k in item}
        # Silence is infinite, so a source that gets it substituted needs
        # a length to stop at. Videos with their own audio end when the
        # file does and need nothing.
        limit = 0.0
        if item.get("kind") == "video" and not item.get("has_audio"):
            limit = await queue.ensure_duration(item)
        try:
            await self._run_source(lambda afd: _clip_cmd(item, afd, limit))
        finally:
            self.now_playing = None
        # Marked played even if ffmpeg failed. A clip that cannot be
        # decoded would otherwise be retried forever, and the stream
        # would never move past it.
        if settings.get().get("loop"):
            await queue.requeue(item["id"])
        else:
            await queue.mark_played(item["id"])

    async def _standby(self) -> None:
        """Black with a clock, until something is queued.

        Not decoration. A frozen pipeline and a working one both show
        black; a second hand is the difference, and it is small enough
        not to be what a motion detector notices.
        """
        proc = await self._spawn(_standby_cmd)
        if proc is None:
            await asyncio.sleep(1.0)
            return
        waiter = asyncio.create_task(queue.arrived.wait())
        exited = asyncio.create_task(proc.wait())
        try:
            await asyncio.wait(
                {waiter, exited}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for task in (waiter, exited):
                task.cancel()
            if proc.returncode is None:
                await _kill(proc)
            self._source = None

    async def _run_source(self, build: Any) -> None:
        proc = await self._spawn(build)
        if proc is None:
            await asyncio.sleep(1.0)
            return
        started = time.monotonic()
        # Wall clock, not monotonic: this is the number a Helix event
        # timestamp is derived from, and the two have to be in the same
        # frame of reference as Verkada's.
        self.source_started_at = time.time()
        if self._on_start is not None:
            try:
                self._on_start(self.now_playing, self.source_started_at)
            except Exception:  # noqa: BLE001 — a listener must never
                # take the stream down with it.
                logger.warning("source-start listener failed", exc_info=True)
        try:
            await proc.wait()
        finally:
            self._source = None
            # How long it actually ran, which is the number that
            # distinguishes "played the clip and joined seamlessly" from
            # "exited instantly and is looping hot". The gap between
            # sources looks identical in both.
            ran = int((time.monotonic() - started) * 1000)
            logger.warning(
                "rtsp source ended after %dms (exit %s)", ran, proc.returncode
            )
            # From here until the next source produces, the pipe is dry.
            self._idle_since = time.monotonic()

    async def _spawn(self, build: Any) -> asyncio.subprocess.Process | None:
        """Start a source. ``build`` takes the audio fd and returns argv.

        The command cannot be formed until the fd is known, and the fd
        belongs to the encoder currently running, so it is handed in here
        rather than captured earlier.
        """
        if self._write_fd is None or self._awrite_fd is None:
            return None
        cmd = build(self._awrite_fd)
        if self._idle_since is not None:
            gap = int((time.monotonic() - self._idle_since) * 1000)
            self.last_gap_ms = gap
            self.worst_gap_ms = max(gap, self.worst_gap_ms or 0)
            self._idle_since = None
            logger.warning("rtsp gap: %dms with nothing feeding the encoder", gap)
        # Same reasoning as the encoder's argv: a source that starts and
        # produces nothing is indistinguishable from one that never
        # started, unless one of them was written down.
        logger.warning("rtsp source: %s", " ".join(cmd))
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=self._write_fd,
                stdin=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                pass_fds=(self._awrite_fd,),
            )
        except OSError as e:
            self.last_error = f"could not start source: {e}"
            return None
        self._source = proc
        # Held, not fired and forgotten. asyncio keeps only a weak
        # reference to a task, so one whose result nobody holds can be
        # collected before it runs -- and this one is what turns a
        # source's stderr into a log line. Losing it means a source that
        # fails says nothing at all, which is exactly what "no ffmpeg
        # lines anywhere" looked like.
        self._source_log_task = asyncio.create_task(self._drain(proc))
        return proc

    def _close_pipe(self) -> None:
        for attr in ("_write_fd", "_read_fd", "_awrite_fd", "_aread_fd"):
            fd = getattr(self, attr)
            if fd is not None:
                with contextlib.suppress(OSError):
                    os.close(fd)
                setattr(self, attr, None)


async def _kill(proc: asyncio.subprocess.Process | None) -> None:
    if proc is None or proc.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=3)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()


# ---- command lines -------------------------------------------------------

def _raw_out() -> list[str]:
    return ["-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"]


def _normalise() -> str:
    """Fit any input into the fixed geometry without distorting it.

    Aspect ratio is preserved and the gap is padded black, because a
    stretched frame is a worse lie than a letterboxed one when the
    recording is going to be reviewed as evidence.
    """
    w, h = settings.WIDTH, settings.HEIGHT
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,"
        f"fps={settings.FPS},format=yuv420p"
    )


def _widen(fd: int, size: int = 1024 * 1024) -> None:
    """Ask the kernel for a bigger pipe buffer. Best effort."""
    try:
        import fcntl

        fcntl.fcntl(fd, getattr(fcntl, "F_SETPIPE_SZ", 1031), size)
    except (ImportError, OSError) as e:
        logger.warning("could not widen pipe buffer: %s", e)


def _redact(arg: str) -> str:
    """Blank the password inside an rtsp:// URL, keep everything else."""
    if "://" not in arg or "@" not in arg:
        return arg
    scheme, _, rest = arg.partition("://")
    creds, _, host = rest.rpartition("@")
    user, _, _pw = creds.partition(":")
    return f"{scheme}://{user}:***@{host}"


def _silence() -> list[str]:
    return [
        "-re", "-f", "lavfi", "-i",
        f"anullsrc=r={settings.AUDIO_RATE}:cl="
        f"{'stereo' if settings.AUDIO_CHANNELS == 2 else 'mono'}",
    ]


# No filtering on the audio path, and specifically no dynaudnorm.
#
# Normalising is genuinely worth having on an 8-bit companded channel --
# and it cost more than it gave. dynaudnorm looks ahead across f*g of
# input before emitting anything, so f=200:g=11 is a 2.2 second buffer.
# On a path where the encoder derives timestamps from sample count and
# cannot compensate, that arrives as audio delayed against video and
# delivered in bursts: an echo and a stutter.
#
# Anything added here has to be judged on latency first and quality
# second. A zero-latency resampler swap would qualify; a lookahead
# normaliser does not.


def _pcm_out(afd: int, seconds: str | None = None) -> list[str]:
    out = ["-ar", str(settings.AUDIO_RATE), "-ac", str(settings.AUDIO_CHANNELS)]
    if seconds:
        out += ["-t", seconds]
    return out + ["-f", "s16le", f"pipe:{afd}"]


def _clip_cmd(item: dict[str, Any], afd: int, limit: float = 0.0) -> list[str]:
    """Video to stdout, audio to the audio pipe, always both.

    A source with no audio track gets silence from lavfi rather than no
    audio output at all. The encoder's audio input has to keep receiving
    samples: starve it and it stalls waiting, which stalls the muxer, and
    a silent clip takes the video down with it.
    """
    # -re paces the read at wall clock. Without it ffmpeg decodes as fast
    # as it can and a 30-second clip flashes past in two.
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-re"]
    seconds = None
    if item.get("kind") == "image":
        seconds = str(item.get("seconds") or queue.DEFAULT_IMAGE_SECONDS)
        cmd += ["-loop", "1", "-t", seconds]
    cmd += ["-i", item["path"]]

    if item.get("has_audio"):
        audio_map = "0:a"
    else:
        cmd += _silence()
        audio_map = "1:a"
        # The silence generator is infinite. Whatever bounds the video --
        # a still's display time, or a video's probed duration -- has to
        # bound the audio too, or the source never exits, the clip never
        # advances, and the stream freezes on its last frame.
        if seconds is None and limit > 0:
            seconds = f"{limit:.3f}"

    cmd += ["-map", "0:v", "-vf", _normalise()] + _raw_out()
    cmd += ["-map", audio_map] + _pcm_out(afd, seconds)
    return cmd


def _standby_cmd(afd: int) -> list[str]:
    w, h, fps = settings.WIDTH, settings.HEIGHT, settings.FPS
    # Escaping matters here: the colons in the time format are argument
    # separators to drawtext unless the whole expansion is left to
    # ffmpeg's own localtime, which is why the text is a bare
    # %{localtime} rather than a strftime string with colons in it.
    text = (
        f"drawtext=fontfile={FONT}:text='%{{localtime}}':"
        f"fontcolor=white@0.55:fontsize={max(18, h // 40)}:x=w-tw-24:y=h-th-24"
    )
    return (
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-re", "-f", "lavfi", "-i", f"color=c=black:s={w}x{h}:r={fps}",
        ]
        + _silence()
        + ["-map", "0:v", "-vf", f"{text},format=yuv420p"]
        + _raw_out()
        + ["-map", "1:a"]
        + _pcm_out(afd)
    )


def _h264(bitrate: str) -> list[str]:
    return [
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-profile:v", "main", "-pix_fmt", "yuv420p",
        # A keyframe every second. A client can only start decoding at
        # one, so this bounds how long "connected" takes to become
        # "showing a picture".
        "-g", str(settings.FPS), "-keyint_min", str(settings.FPS),
        "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bitrate,
    ]


def _g711() -> list[str]:
    """G.711 mu-law, because a Command Connector accepts nothing else.

    Its bitrate is not configurable -- 8-bit samples at 8 kHz is 64
    kbit/s by construction -- so there is no -b:a here to set.
    """
    return [
        "-c:a", "pcm_mulaw",
        "-ar", str(settings.AUDIO_RATE), "-ac", str(settings.AUDIO_CHANNELS),
    ]


def _encoder_cmd(main: str, sub: str, onvif: bool, afd: int) -> list[str]:
    """One process. Three outputs for ONVIF, one for plain RTSP.

    ONVIF advertises a sub-stream and a snapshot, so in that mode the
    encoder produces both. Plain RTSP hands over a single URL and has no
    way to mention either, so producing them would be spending a second
    encode and a JPEG a second on things nothing can ask for.

    Three processes reading one source would need the frames fanned out
    to each, and a pipe has one reader. Splitting inside a single filter
    graph decodes once and keeps the outputs on one process, so they
    share a lifetime and the sub-stream cannot quietly die while the
    device still claims to offer it.
    """
    # Two inputs, both raw and headerless: frames on stdin, PCM on the
    # audio pipe. Input 1 is the audio for every output that has any.
    #
    # -probesize/-analyzeduration are the load-bearing part, and their
    # absence deadlocked this outright.
    #
    # ffmpeg probes its inputs in order, before opening any output. On
    # the audio input it waits for analyzeduration -- five seconds of
    # audio by default -- and while it waits it is not reading the video
    # pipe. That pipe holds 64KB and one 1080p frame is 3.1MB, so the
    # source blocks on its very first frame and therefore stops producing
    # audio as well. The encoder then waits forever for audio the source
    # cannot send, because the encoder is not draining video.
    #
    # Neither input needs probing: every parameter of a raw format is
    # already on this command line. 32 bytes is the documented minimum.
    # With one raw input there was no second input to go and wait on,
    # which is why this only appeared when audio did.
    probe = ["-probesize", "32", "-analyzeduration", "0"]
    inputs = [
        # -y is load-bearing, not boilerplate. The snapshot output writes
        # to a fixed path, and without it ffmpeg refuses the second run
        # with "already exists. Exiting." -- which takes down the two RTSP
        # outputs sharing the process, for a JPEG neither depends on.
        # -stats every few seconds, which is the only way to find out
        # whether this is keeping up. speed below 1x means frames are
        # being produced slower than real time, and a stream that falls
        # behind and catches up is a stream that visibly stutters.
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-stats", "-stats_period", "5",
        *probe,
        "-f", "rawvideo", "-pix_fmt", "yuv420p",
        "-s", f"{settings.WIDTH}x{settings.HEIGHT}", "-r", str(settings.FPS),
        "-i", "pipe:0",
        *probe,
        "-f", "s16le", "-ar", str(settings.AUDIO_RATE),
        "-ac", str(settings.AUDIO_CHANNELS), "-i", f"pipe:{afd}",
    ]
    if not onvif:
        return inputs + [
            "-map", "0:v", *_h264(settings.BITRATE),
            "-map", "1:a", *_g711(),
            "-f", "rtsp", "-rtsp_transport", "tcp", main,
        ]
    return inputs + [
        "-filter_complex",
        (
            f"[0:v]split=3[main][s][j];"
            f"[s]scale={settings.SUB_WIDTH}:{settings.SUB_HEIGHT}[sub];"
            f"[j]fps=1[snap]"
        ),
        "-map", "[main]", *_h264(settings.BITRATE),
        "-map", "1:a", *_g711(),
        "-f", "rtsp", "-rtsp_transport", "tcp", main,
        "-map", "[sub]", *_h264(settings.SUB_BITRATE),
        "-map", "1:a", *_g711(),
        "-f", "rtsp", "-rtsp_transport", "tcp", sub,
        # Overwritten in place rather than accumulating files. ONVIF's
        # GetSnapshotUri points at whatever this last wrote. No audio
        # mapped: a JPEG has nowhere to put it.
        "-map", "[snap]", "-c:v", "mjpeg", "-q:v", "6",
        "-update", "1", "-f", "image2", str(settings.SNAPSHOT_PATH),
    ]


pump = Pump()


async def viewers() -> tuple[int | None, str]:
    """How many clients are pulling either published path."""
    state = settings.get()
    streams = [state.get("stream") or settings.DEFAULT_STREAM]
    if settings.is_onvif(state):
        streams.append(settings.sub_stream(state))
    return await mediamtx.viewers(streams)
