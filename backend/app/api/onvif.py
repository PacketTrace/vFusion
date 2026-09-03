"""The ONVIF endpoints a Command Connector talks to.

Two SOAP services and a JPEG. They live in the same app as the rest of
the API because that is where the state is; the port a client is given
is a second published mapping onto the same container port, not a
separate server.

Authentication is per-operation rather than per-request, for one reason:
``GetSystemDateAndTime`` has to answer without it. A client calls that
first to work out the offset between its clock and ours, and stamps its
password digest in our frame of reference. Demand credentials there and
every later call fails as an authentication error, which sends whoever
is debugging it after the password rather than the clock.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse

from app.onvif import auth, service
from app.rtsp import settings


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/onvif", tags=["onvif"])

XML = "application/soap+xml; charset=utf-8"

# Callable before the client has proved anything, because it is how the
# client works out how to prove it.
OPEN = {"GetSystemDateAndTime"}


def _base(request: Request, state: dict) -> str:
    """The address to put inside responses.

    Whatever the client dialled, not what the container thinks it is. A
    device that answers on one address and describes itself at another
    sends the client somewhere it cannot reach.
    """
    host = str(state.get("advertise_host") or "").strip()
    if host:
        return f"http://{host}:{settings.ONVIF_PUBLIC_PORT}"
    return str(request.base_url).rstrip("/")


async def _dispatch(request: Request) -> Response:
    raw = await request.body()
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        return Response(service.fault(f"malformed request: {e}"), media_type=XML)

    op = service.operation(root)
    state = settings.get()

    if op not in OPEN:
        token = auth.extract(root)
        if not auth.verify(
            token,
            state.get("read_username", ""),
            state.get("read_password", ""),
        ):
            # 400 rather than 401: ONVIF carries the failure in a SOAP
            # fault, and a client reading the body expects a 4xx it can
            # still parse rather than a WWW-Authenticate challenge for a
            # scheme it is not using.
            return Response(
                service.unauthorized(), media_type=XML, status_code=400
            )

    body = _respond(op, root, state, _base(request, state))
    if body is None:
        logger.info("onvif: unhandled operation %s", op or "(none)")
        return Response(
            service.fault(f"{op or 'operation'} is not supported"),
            media_type=XML,
            status_code=400,
        )
    return Response(service.envelope(body), media_type=XML)


def _respond(op: str, root, state: dict, base: str) -> str | None:
    # Dispatch is by operation name alone. The two service endpoints
    # exist because ONVIF says they do, not because the operation sets
    # overlap -- no name is served by both.

    if op == "GetSystemDateAndTime":
        return service.system_date_and_time(datetime.now(timezone.utc))
    if op == "GetDeviceInformation":
        return service.device_information(state)
    if op == "GetCapabilities":
        return service.capabilities(base)
    if op in ("GetServices", "GetServiceCapabilities"):
        return service.services(base)
    if op == "GetScopes":
        return service.scopes()
    if op == "GetUsers":
        return service.users(state)
    if op == "GetProfiles":
        return service.profiles(state)
    if op == "GetProfile":
        return service.profile(state, service.profile_token(root))
    if op == "GetVideoSources":
        return service.video_sources()
    if op == "GetStreamUri":
        return service.stream_uri(state, service.profile_token(root))
    if op == "GetSnapshotUri":
        return service.snapshot_uri(state)
    return None


@router.post("/device_service")
async def device_service(request: Request) -> Response:
    return await _dispatch(request)


@router.post("/media_service")
async def media_service(request: Request) -> Response:
    return await _dispatch(request)


@router.get("/snapshot.jpg")
async def snapshot() -> Response:
    """The most recent frame, written once a second by the encoder.

    Unauthenticated, and deliberately so: the URI is only reachable by
    something that already authenticated to be told about it, and clients
    fetch this from image widgets that cannot carry a SOAP header.
    """
    path = settings.SNAPSHOT_PATH
    if not path.is_file():
        # 503 rather than 404: the resource exists as a concept and will
        # appear once the stream is running. A 404 reads as "wrong URL".
        return Response(
            "no frame yet — the stream is not running",
            media_type="text/plain",
            status_code=503,
        )
    return FileResponse(path, media_type="image/jpeg")
