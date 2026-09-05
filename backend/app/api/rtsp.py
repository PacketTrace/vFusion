"""The virtual camera: turn it on, hand out its URL, feed it media.

Nothing here does any encoding — that is ``app.rtsp.pump``, which holds
one stream open for as long as the switch is on. These endpoints only
change what the pump is told and report back what it is doing.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.api import onvif as onvif_api
from app.rtsp import fetch, mediamtx, pump as pump_mod, queue, settings


router = APIRouter(prefix="/api/rtsp", tags=["rtsp"])

# Big enough for a few minutes of 1080p, small enough that a mistaken
# drag-and-drop of something enormous fails fast rather than filling the
# volume.
MAX_UPLOAD_BYTES = 512 * 1024 * 1024


class SettingsIn(BaseModel):
    # What the Command Connector will be told to connect to. Not
    # derivable from inside the container, which only knows its own
    # compose-network name.
    advertise_host: str | None = None
    loop: bool | None = None
    mode: Literal["onvif", "rtsp"] | None = None


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
    was = settings.get().get("mode")
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
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB",
        )
    if queue.kind_for(file.filename or "") is None:
        raise HTTPException(
            status_code=400,
            detail="Only video (mp4, mov, mkv, webm, ts) and images (jpg, png, webp).",
        )
    try:
        entry = await queue.add(file.filename or "upload", data, seconds)
    except (ValueError, RuntimeError) as e:
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
