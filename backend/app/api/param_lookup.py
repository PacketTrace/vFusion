"""Where to go and get an id you do not have.

The API runner lists 166 endpoints and a great many of them want an id
you cannot possibly know by heart -- ``access_level_id``,
``door_exception_calendar_id``, ``guest_visit_id``. The runner would show
an empty box and refuse to run, and the only way forward was to know
which *other* call lists those and to go run it somewhere else first.

The answer is in the spec we already crawl. For a path like
``/access/v1/door/access_level/{access_level_id}`` the call that lists
them is the same path with the parameter segment removed -- that is what
REST means -- and the catalog knows whether that GET exists. Where the
convention does not hold, we fall back to any GET whose response
mentions the parameter by name.

Nothing here is hand-maintained per endpoint. A new Verkada resource
gets a lookup the day the crawler sees it, which is the only way this
keeps working across 166 endpoints and counting.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import VerkadaApiEndpoint


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/param-lookup", tags=["api-runner"])

_PARAM_RE = re.compile(r"\{([^}]+)\}")

# Field names worth showing a human instead of a uuid, best first. A
# picker that lists thirty identical-looking ids is the same problem
# over again.
LABEL_FIELDS = [
    "name",
    "full_name",
    "display_name",
    "label",
    "title",
    "email",
    "description",
    "site_name",
    "camera_name",
    "door_name",
]


class Lookup(BaseModel):
    param: str
    method: str
    path: str
    summary: str | None = None
    # How confident we are that this is the right call, so the UI can
    # say "list them" versus "this might be it".
    confidence: str  # "exact" | "guess"
    reason: str


class LookupResponse(BaseModel):
    lookups: list[Lookup]
    # Params we could not find a source for. Named rather than silently
    # omitted -- "no lookup offered" and "we did not look" are different
    # things and the UI should not have to guess which happened.
    unresolved: list[str]


def _params_in(path: str) -> list[str]:
    return _PARAM_RE.findall(path or "")


def _collection_path(path: str, param: str) -> str | None:
    """``/a/b/{x_id}`` -> ``/a/b``, but only when the parameter is the
    last segment. A parameter in the middle
    (``/a/{x_id}/b``) is a sub-resource; dropping it produces a path
    that means something else entirely."""
    segments = (path or "").split("/")
    if not segments or segments[-1] != "{" + param + "}":
        return None
    return "/".join(segments[:-1]) or None


def _mentions_param(row: VerkadaApiEndpoint, param: str) -> bool:
    """Does this operation's response talk about ``param``?

    Crude on purpose -- a substring search over the serialized operation
    beats resolving $refs through a spec we would have to load in full,
    and a false positive here costs a wrong suggestion the operator can
    see and ignore, not a wrong call.
    """
    raw = row.raw
    if not isinstance(raw, dict):
        return False
    try:
        import json

        return f'"{param}"' in json.dumps(raw.get("responses") or {}, default=str)
    except Exception:  # noqa: BLE001
        return False


@router.get("", response_model=LookupResponse)
async def lookups_for(
    path: str = Query(..., description="The endpoint path being run"),
    session: AsyncSession = Depends(get_session),
) -> LookupResponse:
    params = _params_in(path)
    if not params:
        return LookupResponse(lookups=[], unresolved=[])

    rows = (
        (
            await session.execute(
                select(VerkadaApiEndpoint).where(
                    VerkadaApiEndpoint.deleted_at.is_(None),
                    VerkadaApiEndpoint.method == "GET",
                )
            )
        )
        .scalars()
        .all()
    )
    by_path = {r.path: r for r in rows}

    out: list[Lookup] = []
    unresolved: list[str] = []
    for param in params:
        collection = _collection_path(path, param)
        row = by_path.get(collection) if collection else None
        if row is not None:
            out.append(
                Lookup(
                    param=param,
                    method="GET",
                    path=row.path,
                    summary=row.summary,
                    confidence="exact",
                    reason=f"{row.path} is the collection this id belongs to",
                )
            )
            continue

        # Convention did not hold. Anything that returns the field, with
        # no ids of its own to supply -- a lookup that needs a lookup is
        # not a lookup.
        candidates = [
            r
            for r in rows
            if not _params_in(r.path) and _mentions_param(r, param)
        ]
        # Shortest path first: the plain collection beats a report or a
        # filtered sub-view that happens to include the same field.
        candidates.sort(key=lambda r: len(r.path))
        if candidates:
            r = candidates[0]
            out.append(
                Lookup(
                    param=param,
                    method="GET",
                    path=r.path,
                    summary=r.summary,
                    confidence="guess",
                    reason=f"{r.path} returns a {param} and needs no ids itself",
                )
            )
        else:
            unresolved.append(param)

    return LookupResponse(lookups=out, unresolved=unresolved)


def extract_options(body: Any, param: str) -> list[dict[str, str]]:
    """Pull ``{value, label}`` pairs for ``param`` out of a response.

    Verkada wraps collections under different keys per endpoint
    (``access_levels``, ``doors``, ``events``…), so rather than knowing
    each one we walk the response for the first list of objects that
    actually carries the field.
    """
    found: list[dict[str, str]] = []

    def walk(node: Any, depth: int = 0) -> bool:
        if depth > 6 or found:
            return bool(found)
        if isinstance(node, list):
            items = [x for x in node if isinstance(x, dict) and param in x]
            if items:
                for item in items:
                    label = next(
                        (
                            str(item[f])
                            for f in LABEL_FIELDS
                            if isinstance(item.get(f), (str, int, float))
                            and str(item[f]).strip()
                        ),
                        "",
                    )
                    found.append({"value": str(item[param]), "label": label})
                return True
            for x in node:
                if walk(x, depth + 1):
                    return True
            return False
        if isinstance(node, dict):
            for v in node.values():
                if walk(v, depth + 1):
                    return True
        return False

    walk(body)
    # Dedupe by value, first label wins.
    seen: set[str] = set()
    unique: list[dict[str, str]] = []
    for o in found:
        if o["value"] in seen:
            continue
        seen.add(o["value"])
        unique.append(o)
    return unique[:200]


class ResolveRequest(BaseModel):
    connection_id: Any = None
    token: str | None = None
    method: str = "GET"
    path: str
    param: str


class ResolveResponse(BaseModel):
    options: list[dict[str, str]]
    status_code: int
    # Shown when the call worked but nothing in the response carried the
    # field. That is a different failure from an error, and rendering it
    # as an empty dropdown would read as "this org has none".
    note: str | None = None


@router.post("/resolve", response_model=ResolveResponse)
async def resolve(
    body: ResolveRequest,
    session: AsyncSession = Depends(get_session),
) -> ResolveResponse:
    """Run the lookup call and hand back pickable values."""
    from app.api.api_runner import RunRequest, run as run_endpoint

    result = await run_endpoint(
        RunRequest(
            connection_id=body.connection_id,
            token=body.token,
            method=body.method,
            path=body.path,
        ),
        session=session,
    )
    status = int(result.get("status_code") or 0)
    if not result.get("ok") or status >= 400:
        return ResolveResponse(
            options=[],
            status_code=status,
            note=f"{body.method} {body.path} answered {status}.",
        )

    options = extract_options(result.get("body"), body.param)
    note = None
    if not options:
        note = (
            f"{body.method} {body.path} answered {status}, but nothing in the "
            f"response carried a {body.param}. It may be the wrong call for "
            "this id."
        )
    return ResolveResponse(options=options, status_code=status, note=note)
