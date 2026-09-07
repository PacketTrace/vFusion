"""Live camera video, served to the browser as plain HLS.

The session is opened once, then polled like any HLS stream: the player
fetches the playlist every couple of seconds and the segments named in
it. Those fetches are also the keep-alive -- there is no separate
heartbeat, because a player that has stopped asking is a viewer who has
gone, and that is exactly when the transcode should stop.

Everything here sits behind the session-cookie middleware like the rest
of ``/api``. A camera feed reachable without one would be worse than no
feature at all.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto import decrypt_secret
from app.db import get_session
from app.live import hls
from app.models import Connection, VerkadaCamera


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/live", tags=["live"])

# ffmpeg writes exactly this shape. Anything else in the path is not a
# segment we produced, and a URL is not the place to find out.
_SEGMENT_RE = re.compile(r"^seg\d{6}\.ts$")


class OpenRequest(BaseModel):
    camera_id: str
    connection_id: UUID | None = None


async def _verkada_credentials(
    session: AsyncSession, conn_id: UUID | None
) -> tuple[str, str, str | None]:
    conn: Connection | None = None
    if conn_id:
        conn = await session.get(Connection, conn_id)
    if conn is None:
        conn = (
            await session.execute(
                select(Connection)
                .where(Connection.type == "verkada")
                .order_by(Connection.created_at.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if conn is None or conn.type != "verkada":
        raise HTTPException(
            status_code=400,
            detail="No Verkada connection configured — add one on the Connections page.",
        )
    try:
        secret = decrypt_secret(conn.encrypted_secret) or {}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decrypt secret: {e}") from e
    api_key = secret.get("api_key")
    org_id = secret.get("org_id") or conn.external_id
    if not api_key:
        raise HTTPException(status_code=400, detail="That connection has no API key.")
    if not org_id:
        raise HTTPException(status_code=400, detail="That connection has no org_id.")
    # Same regional host for the token and the stream, or neither works.
    return api_key, org_id, secret.get("region") or None


@router.post("")
async def open_stream(
    body: OpenRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    api_key, org_id, region = await _verkada_credentials(session, body.connection_id)
    camera = (
        await session.execute(
            select(VerkadaCamera).where(VerkadaCamera.camera_id == body.camera_id).limit(1)
        )
    ).scalar_one_or_none()
    try:
        live = await hls.manager.open(
            camera_id=body.camera_id,
            name=(camera.name if camera and camera.name else body.camera_id),
            api_key=api_key,
            org_id=org_id,
            base_url=region,
        )
    except hls.LiveError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    return live.public()


@router.get("")
async def list_streams() -> dict[str, Any]:
    return {
        "sessions": [s.public() for s in hls.manager.all()],
        "max_sessions": hls.MAX_SESSIONS,
    }


@router.get("/{session_id}")
async def stream_status(session_id: str) -> dict[str, Any]:
    live = hls.manager.get(session_id)
    if live is None:
        raise HTTPException(status_code=404, detail="That stream is no longer open.")
    live.touch()
    return live.public()


@router.delete("/{session_id}")
async def close_stream(session_id: str) -> dict[str, bool]:
    return {"closed": await hls.manager.close(session_id)}


@router.get("/{session_id}/index.m3u8")
async def playlist(session_id: str) -> Response:
    live = hls.manager.get(session_id)
    if live is None:
        raise HTTPException(status_code=404, detail="That stream is no longer open.")
    live.touch()
    if live.error:
        raise HTTPException(status_code=502, detail=live.error)
    if not live.ready:
        # The first segments are still being written. 503 rather than an
        # empty playlist: a player handed a valid-but-empty manifest
        # treats it as a stream that has ended.
        raise HTTPException(status_code=503, detail="starting")
    return FileResponse(
        live.playlist_path,
        media_type="application/vnd.apple.mpegurl",
        # A live playlist is different every time it is asked for.
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{session_id}/{filename}")
async def segment(session_id: str, filename: str) -> Response:
    live = hls.manager.get(session_id)
    if live is None:
        raise HTTPException(status_code=404, detail="That stream is no longer open.")
    if not _SEGMENT_RE.match(filename):
        raise HTTPException(status_code=404, detail="No such segment.")
    live.touch()
    path = live.dir / filename
    if not path.exists():
        # Segments roll out of the window; a player asking late is normal.
        raise HTTPException(status_code=404, detail="That segment has expired.")
    return FileResponse(
        path,
        media_type="video/mp2t",
        # Immutable while it exists, and it exists for about a dozen
        # seconds. Long enough for a retry, short enough not to matter.
        headers={"Cache-Control": "max-age=10"},
    )
