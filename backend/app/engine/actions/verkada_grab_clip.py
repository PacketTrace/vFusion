"""Action: pull a short historical MP4 clip out of Verkada via HLS.

Designed to feed the Gemini video analyzer step. Verkada serves SD
transcodes first and backfills HD only after the full segment uploads,
so by default we wait ``pre_grab_delay_sec`` (60s) before pulling. Lower
that for low-res cameras that never have HD to backfill.

Clip lands at ``/app/data/clips/{uuid}.mp4`` and is referenced by path
in the step output so downstream actions (Gemini) can read it.
"""

import asyncio
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.connectors.verkada.footage import CLIP_ROOT, FootageError, grab_video_clip
from app.crypto import decrypt_secret
from app.engine.templates import resolve_deep
from app.models import Connection


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "connection_id",
            "label": "Verkada connection",
            "type": "connection_ref",
            "connection_type": "verkada",
            "required": True,
        },
        {
            "name": "camera_id",
            "label": "Camera ID",
            "type": "text",
            "required": True,
            "help": 'Usually {{ trigger.data.camera_id }}.',
        },
        {
            "name": "start_epoch",
            "label": "Start time (unix seconds)",
            "type": "text",
            "required": True,
            "help": 'Usually {{ trigger.data.created }}.',
        },
        {
            "name": "duration_sec",
            "label": "Clip duration (seconds)",
            "type": "text",
            "required": False,
            "help": "Default 10. Keep short — Gemini charges per second.",
        },
        {
            "name": "pre_grab_delay_sec",
            "label": "Wait before grab (seconds)",
            "type": "text",
            "required": False,
            "help": "Default 60. Verkada needs ~30–45s to backfill HD on 4K+ cameras.",
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "verkada_grab_clip",
    "camera_id": "...",
    "clip_path": "/app/data/clips/abc.mp4",
    "duration_sec": 10,
    "file_size": 1234567,
    "started_at_epoch": 1700000000,
    "grabbed_at_epoch": 1700000060,
}


def _coerce_int(v: Any, default: int) -> int:
    try:
        return int(float(str(v).strip()))
    except (ValueError, TypeError):
        return default


def _coerce_float(v: Any, default: float) -> float:
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return default


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    secret = decrypt_secret(connection.encrypted_secret)
    api_key = secret.get("api_key")
    org_id = secret.get("org_id") or connection.external_id
    if not api_key:
        raise ValueError("Verkada connection has no api_key set")
    if not org_id:
        raise ValueError("Verkada connection has no org_id")

    camera_id = resolve_deep(config.get("camera_id"), ctx)
    start_epoch_raw = resolve_deep(config.get("start_epoch"), ctx)
    duration_raw = resolve_deep(config.get("duration_sec"), ctx)
    delay_raw = resolve_deep(config.get("pre_grab_delay_sec"), ctx)

    if not isinstance(camera_id, str) or not camera_id:
        raise ValueError("camera_id is required (string)")
    start_epoch = _coerce_int(start_epoch_raw, 0)
    if start_epoch <= 0:
        raise ValueError(f"start_epoch must be a positive unix-seconds value, got {start_epoch_raw!r}")
    duration_sec = max(1.0, _coerce_float(duration_raw, 10.0))
    delay_sec = max(0.0, _coerce_float(delay_raw, 60.0))

    # Wait for Verkada to finish uploading + HD backfill.
    started_grab_at = start_epoch + int(delay_sec)
    wait_remaining = started_grab_at - int(time.time())
    if wait_remaining > 0:
        await asyncio.sleep(wait_remaining)

    clip_id = uuid4().hex
    out_path = CLIP_ROOT / f"{clip_id}.mp4"
    try:
        size = await grab_video_clip(
            api_key=api_key,
            org_id=org_id,
            camera_id=camera_id,
            start_epoch=start_epoch,
            duration_sec=duration_sec,
            out_path=out_path,
        )
    except FootageError as e:
        raise ValueError(str(e)) from e

    return {
        "action": "verkada_grab_clip",
        "camera_id": camera_id,
        "clip_path": str(out_path),
        "duration_sec": duration_sec,
        "file_size": size,
        "started_at_epoch": start_epoch,
        "grabbed_at_epoch": int(time.time()),
    }
