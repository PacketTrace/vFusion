"""The virtual camera: turn it on, hand out its URL, feed it media.

Nothing here does any encoding — that is ``app.rtsp.pump``, which holds
one stream open for as long as the switch is on. These endpoints only
change what the pump is told and report back what it is doing.
"""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.rtsp import mediamtx, pump as pump_mod, queue, settings


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


class EnableIn(BaseModel):
    enabled: bool


@router.get("/status")
async def status() -> dict:
    state = settings.public()
    items = queue.list_all()
    return {
        **state,
        "pump": pump_mod.pump.status(),
        # None means the RTSP server did not answer; 0 means it did and
        # nobody is watching. Collapsing those into one number is how you
        # end up debugging the wrong end.
        "readers": await pump_mod.readers(),
        "queued": sum(1 for i in items if not i.get("played_at")),
        "played": sum(1 for i in items if i.get("played_at")),
    }


@router.put("/settings")
async def update_settings(body: SettingsIn) -> dict:
    entry = {k: v for k, v in body.model_dump().items() if v is not None}
    state = await settings.put(entry)
    # The config carries the credentials, so it is rewritten whenever they
    # or the stream name change. Writing is a no-op when the contents
    # match, which matters: MediaMTX restarts itself to pick a config up,
    # and that drops whoever is watching.
    mediamtx.write(settings.get())
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
    # The Connector is holding a session opened with the old password.
    # MediaMTX does not tear that down on reload, so the camera keeps
    # working until it next reconnects — at which point it needs the new
    # one. Saying so is the difference between a planned change and a
    # camera that goes offline overnight for no visible reason.
    return {**result, "note": "Update the camera in Command before it reconnects."}


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
