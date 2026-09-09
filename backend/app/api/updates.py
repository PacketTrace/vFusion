"""Update check — is a newer release out, and what to run to get it.

Two endpoints and no third. There is deliberately no "apply" here: see
``app.updates`` for why an app that can unlock doors does not get the
Docker socket.

  - ``GET  /api/update``          — cached answer for the banner.
  - ``POST /api/update/dismiss``  — hide the banner for one version.

Behind the session gate, because it makes an outbound request and
because the release channel is a detail of this install rather than
something the login screen needs.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from app import updates


router = APIRouter(prefix="/api/update", tags=["update"])


class DismissBody(BaseModel):
    version: str


@router.get("")
async def get_update(force: bool = False) -> dict:
    return await updates.check(force=force)


@router.post("/dismiss")
async def post_dismiss(body: DismissBody) -> dict:
    await updates.dismiss(body.version.strip())
    return {"ok": True}
