"""The virtual camera: turn it on, hand out its URL, feed it media.

Nothing here does any encoding — that is ``app.rtsp.pump``, which holds
one stream open for as long as the switch is on. These endpoints only
change what the pump is told and report back what it is doing.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.api import onvif as onvif_api
from app.rtsp import fetch, mediamtx, pump as pump_mod, queue, settings


router = APIRouter(prefix="/api/rtsp", tags=["rtsp"])

# Big enough for a few minutes of 1080p, small enough that a mistaken
# drag-and-drop of something enormous fails fast rather than filling the
# volume.
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024


class SettingsIn(BaseModel):
    # What the Command Connector will be told to connect to. Not
    # derivable from inside the container, which only knows its own
    # compose-network name.
    advertise_host: str | None = None
    loop: bool | None = None
    mode: Literal["onvif", "rtsp"] | None = None
    # What the camera plays. "queue" walks the uploaded clips; "live"
    # mirrors one continuous source forever. Not a queue item -- a live
    # source never ends, so "third of five, then repeat" has no meaning
    # for it, and loop does not apply.
    source: Literal["queue", "live"] | None = None
    live_url: str | None = None


# What the resolver can actually open. yt-dlp takes a web page, ffmpeg
# takes a stream; everything else -- a local path, a typo, a "file://"
# someone pasted from a player -- fails later, inside the pump, where
# the only evidence is a line in the log. Refusing it here puts the
# error next to the field that caused it.
_LIVE_SCHEMES = (
    "http://",
    "https://",
    "rtsp://",
    "rtsps://",
    "rtmp://",
    "rtmps://",
    "srt://",
    "udp://",
    "hls://",
)


class EnableIn(BaseModel):
    enabled: bool


@router.get("/status")
async def status() -> dict:
    state = settings.public()
    items = queue.list_all()
    return {
        **state,
        "pump": pump_mod.pump.status(),
        # None means we could not ask and carries why; 0 means we asked
        # and nobody is watching. Collapsing those into one value is what
        # made the previous attempt at this unreadable.
        **dict(zip(("viewers", "viewers_error"), await pump_mod.viewers())),
        # Whether the RTSP server is actually serving the paths we claim
        # to publish. "publishing" only means our ffmpeg is alive, which
        # stayed true through a day of the Connector being refused a
        # path the config had dropped.
        "paths": await pump_mod.health(),
        "queued": sum(1 for i in items if not i.get("played_at")),
        "played": sum(1 for i in items if i.get("played_at")),
        # What ONVIF clients have tried lately. "Invalid credentials"
        # from a client is a claim about a scheme mismatch as often as
        # about a password, and this is how you tell which.
        "onvif_requests": list(reversed(onvif_api.recent)),
        "fetches": fetch.recent(),
    }


@router.put("/settings")
async def update_settings(body: SettingsIn) -> dict:
    entry = {k: v for k, v in body.model_dump().items() if v is not None}
    if entry.get("live_url"):
        candidate = str(entry["live_url"]).strip()
        if not candidate.lower().startswith(_LIVE_SCHEMES):
            raise HTTPException(
                status_code=400,
                detail=(
                    "That does not look like a stream address. Paste a page "
                    "URL the resolver can read, or a direct stream "
                    "(rtsp://, or a link ending in .m3u8)."
                ),
            )
        entry["live_url"] = candidate
    before = settings.get()
    was = before.get("mode")
    state = await settings.put(entry)
    # The config carries the credentials, so it is rewritten whenever they
    # or the stream name change. Writing is a no-op when the contents
    # match, which matters: MediaMTX restarts itself to pick a config up,
    # and that drops whoever is watching.
    mediamtx.write(settings.get())
    # Switching mode changes what the encoder produces — one output or
    # three — so the encoder has to be rebuilt. This is the one settings
    # change that interrupts the stream, which is why the UI says so.
    if entry.get("mode") and entry["mode"] != was and settings.get().get("enabled"):
        await pump_mod.pump.stop()
        pump_mod.pump.start()
    # Changing what the camera plays takes effect at the next source
    # change, and a live source never has one -- left alone, switching
    # away from a working live stream would do nothing visible until it
    # dropped by itself. Skip ends the current source without touching
    # the encoder, so the loop picks the new setting up now and the
    # Connector never sees the camera go away.
    elif any(
        k in entry and entry[k] != before.get(k) for k in ("source", "live_url")
    ):
        pump_mod.pump.skip()
    return state


@router.post("/enable")
async def enable(body: EnableIn) -> dict:
    state = settings.get()
    if body.enabled and not str(state.get("advertise_host") or "").strip():
        raise HTTPException(
            status_code=400,
            detail=(
                "Set the address the Command Connector will reach first — "
                "the container cannot work out its own LAN address."
            ),
        )
    result = await settings.put({"enabled": body.enabled})
    if body.enabled:
        mediamtx.write(settings.get())
        pump_mod.pump.start()
    else:
        await pump_mod.pump.stop()
    return result


@router.post("/rotate-password")
async def rotate() -> dict:
    result = await settings.rotate_read_password()
    mediamtx.write(settings.get())
    # This is not a quiet change. The new password only reaches MediaMTX
    # through its config, and MediaMTX picks a config up by restarting --
    # which drops every session, including the Connector's. It comes back
    # holding the old password and is refused until Command is updated.
    # So: the camera goes offline the moment this is pressed, and stays
    # offline until the new password is pasted in.
    return {
        **result,
        "note": (
            "The camera goes offline now and stays offline until this "
            "password is updated in Command."
        ),
    }


@router.get("/queue")
async def list_queue() -> list[dict]:
    return [
        {k: v for k, v in item.items() if k != "path"}
        for item in queue.list_all()
    ]


@router.post("/queue")
async def upload(
    file: UploadFile = File(...),
    seconds: int | None = Form(default=None),
) -> dict:
    # Streamed to disk, never assembled in memory.
    #
    # The previous version read the body in chunks and then joined them,
    # which held the whole file TWICE at peak — a 900 MB upload needed
    # 1.8 GB, and the process died before it could refuse anything. The
    # version before that held it once and measured it afterwards, so an
    # oversized upload was fully buffered just to be rejected. Writing
    # as it arrives costs neither.
    if queue.kind_for(file.filename or "") is None:
        raise HTTPException(
            status_code=400,
            detail="Only video (mp4, mov, mkv, webm, ts) and images (jpg, png, webp).",
        )
    item_id = uuid.uuid4().hex
    suffix = Path(file.filename or "").suffix.lower()
    stored = queue.MEDIA_DIR / f"{item_id}{suffix}"
    total = 0
    try:
        queue.MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        with stored.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "file is larger than "
                            f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB"
                        ),
                    )
                out.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="empty file")
    except HTTPException:
        # A half-written file is not a clip. Leaving it would put a
        # truncated video in MEDIA_DIR with nothing pointing at it.
        stored.unlink(missing_ok=True)
        raise
    except OSError as e:
        stored.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"could not store upload: {e}")

    try:
        # The bytes are already where they need to be; this only records
        # them. probe() reads the file from disk, which is what it did
        # before too.
        entry = await queue.register(stored, file.filename or "upload", seconds)
    except (ValueError, RuntimeError) as e:
        stored.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {k: v for k, v in entry.items() if k != "path"}


class FetchIn(BaseModel):
    url: str


@router.post("/queue/url")
async def fetch_url(body: FetchIn) -> dict:
    url = body.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Needs an http or https URL.")
    # Returns as soon as the download starts, not when it finishes. A
    # video takes minutes to fetch and a request held open that long is
    # indistinguishable from one that has hung; progress comes back
    # through /status instead.
    return await fetch.start(url)


@router.post("/queue/skip")
async def skip_current() -> dict:
    """Stop what is playing and move to the next item."""
    return {"skipped": pump_mod.pump.skip()}


@router.post("/queue/{item_id}/set-aside")
async def set_aside(item_id: str) -> dict:
    """Take an item out of the running order without deleting the file.

    Delete was the only way to stop something playing, which meant
    "not this week" and "never again" were the same button — and one of
    them destroys a file you may have uploaded once and cannot easily
    get back. This moves it to Played, where Play again brings it back.
    """
    if not await queue.mark_played(item_id):
        raise HTTPException(status_code=404, detail="not found")
    # Nothing is skipped here: if it happens to be on air, it plays out.
    # Setting aside is about the running order, not about interrupting.
    return {"ok": True}


@router.post("/queue/{item_id}/requeue")
async def requeue(item_id: str) -> dict:
    if not await queue.requeue(item_id):
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@router.delete("/queue/{item_id}")
async def delete(item_id: str) -> dict:
    if not await queue.remove(item_id):
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": True}


@router.post("/queue/clear-played")
async def clear_played() -> dict:
    return {"removed": await queue.clear_played()}


@router.get("/viewers")
async def viewers() -> dict:
    """Who is pulling the stream right now.

    Its own endpoint rather than part of status: the session list is a
    second API call, and status is polled continuously while this is
    asked for once, when somebody wants the answer.
    """
    return await pump_mod.readers()
