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


# Supplied by the client on every call, so it never counts against an
# endpoint being runnable with nothing filled in.
_AMBIENT = {"org_id"}


def _required_params(row: VerkadaApiEndpoint) -> set[str]:
    """Parameters this operation will not run without.

    The bug this exists to fix: ``GET /access/v1/access_groups/group``
    has no {placeholders}, so it looked like a listing call — and it is
    the get-ONE endpoint, which requires group_id as a query parameter.
    Offering it as the way to find a group_id asks Verkada for the id
    using the id, and answers 400.
    """
    raw = row.raw
    if not isinstance(raw, dict):
        return set()
    out: set[str] = set()
    for prm in raw.get("parameters") or []:
        if not isinstance(prm, dict):
            continue
        if prm.get("required") and prm.get("name") not in _AMBIENT:
            out.add(str(prm.get("name")))
    return out


def _runnable_bare(row: VerkadaApiEndpoint) -> bool:
    """Can this be called with nothing filled in?"""
    return not _params_in(row.path) and not _required_params(row)


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


def _noun_of(param: str) -> str:
    """``user_id`` -> ``user``. The resource an id points at."""
    return re.sub(r"_?(id|uid|uuid)$", "", param).strip("_")


def _by_name(rows: list[VerkadaApiEndpoint], param: str) -> VerkadaApiEndpoint | None:
    """A GET whose path names the resource this id points at.

    For a query parameter there is no path segment to strip, so the
    convention that works for ``/x/{x_id}`` has nothing to bite on.
    ``user_id`` still has to lead somewhere, and the endpoint that lists
    users is the one whose path ends in ``user`` or ``users``.
    """
    noun = _noun_of(param)
    if not noun:
        return None
    plurals = {noun + "s", noun + "es"}
    wanted = {noun} | plurals
    # Also the plural of the last word: "access_user" -> "access_users".
    parts = noun.split("_")
    if parts:
        wanted.add("_".join(parts[:-1] + [parts[-1] + "s"]))

    def score(r: VerkadaApiEndpoint) -> tuple[int, int] | None:
        seg = r.path.rsplit("/", 1)[-1]
        if seg in wanted:
            return (0, len(r.path))
        # "/access/v1/access_groups" is the collection for group_id even
        # though its last segment is not "groups" — Verkada prefixes the
        # resource. Endswith catches it without matching unrelated paths.
        if any(seg.endswith(pl) for pl in plurals):
            return (1, len(r.path))
        return None

    scored = []
    for r in rows:
        # Must be runnable with nothing filled in, or it is not a lookup.
        if not _runnable_bare(r):
            continue
        rank = score(r)
        if rank is not None:
            scored.append((rank, r))
    scored.sort(key=lambda t: t[0])
    return scored[0][1] if scored else None


@router.get("", response_model=LookupResponse)
async def lookups_for(
    path: str = Query(..., description="The endpoint path being run"),
    params: str | None = Query(
        default=None,
        description=(
            "Comma-separated parameter names to resolve, beyond the "
            "{placeholders} in the path. Query parameters take ids too — "
            "user_id is a query parameter on most access endpoints — and "
            "resolving only path parameters left exactly the fields "
            "nobody can fill."
        ),
    ),
    session: AsyncSession = Depends(get_session),
) -> LookupResponse:
    wanted = _params_in(path)
    for extra in (params or "").split(","):
        name = extra.strip()
        # Only things that look like an identifier. Offering to "look
        # up" page_size would be noise on every endpoint.
        if name and name not in wanted and re.search(r"(^|_)(id|uid|uuid)$", name):
            wanted.append(name)
    params_list = wanted
    if not params_list:
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
    for param in params_list:
        collection = _collection_path(path, param)
        row = by_path.get(collection) if collection else None
        # A collection that itself demands a required parameter is the
        # same trap one level up.
        if row is not None and not _required_params(row):
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

        named = _by_name(rows, param)
        if named is not None:
            out.append(
                Lookup(
                    param=param,
                    method="GET",
                    path=named.path,
                    summary=named.summary,
                    confidence="exact",
                    reason=f"{named.path} lists the {_noun_of(param)}s this id refers to",
                )
            )
            continue

        # Convention did not hold. Anything that returns the field, with
        # no ids of its own to supply -- a lookup that needs a lookup is
        # not a lookup.
        candidates = [
            r for r in rows if _runnable_bare(r) and _mentions_param(r, param)
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
