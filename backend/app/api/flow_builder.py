"""Natural-language flow authoring — propose a flow from a sentence.

The model does **not** emit flow rows. It emits the same *template* object
the built-in starter templates use (`app/data/flow_templates/*.json`):
trigger + nodes + optional helix_event_types, with `connection_id` left
null. That format already has an installer, a Helix provisioner and a
validator behind it, so the surface where a language model can do damage
is a single well-specified JSON document rather than the database.

Three things make the output trustworthy enough to show someone:

  1. Grounding — the prompt carries the org's actual synced cameras,
     doors and Helix event types, plus the real trigger taxonomy and
     action catalog. A model that can see the camera list stops inventing
     camera IDs.
  2. Validation — every action_type and config key is checked against the
     live ACTIONS registry, and the DAG is topologically sorted. Failures
     go back to the model once as a repair prompt.
  3. Replay — the proposed trigger is run against real stored webhook
     events via the same matcher the ingest path uses, so the answer to
     "will this fire?" is evidence rather than opinion.

This endpoint is read-only: it proposes, it never saves.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.schemas import TAXONOMY
from app.crypto import decrypt_secret
from app.db import get_session
from app.engine.actions import ACTIONS
from app.engine.triggers import matches as trigger_matches
from app.pricing import ledger
from app.pricing.gemini import cost_for
from app.models import (
    Connection,
    Run,
    VerkadaCamera,
    VerkadaDoor,
    VerkadaHelixEventType,
    WebhookEvent,
)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/flow-builder", tags=["flow-builder"])

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "data" / "flow_templates"

# How far back to look when answering "would this have fired?".
REPLAY_LIMIT = 2000

# How many past runs to average when pricing a proposed flow.
RUN_HISTORY_LIMIT = 500

# Pro first. Drafting a flow is a one-off cost per attempt, not a per-firing
# one, and the difference in output quality is worth more than the fraction
# of a cent. Flash is the fallback if Pro is unavailable.
MODEL_CHAIN = ("gemini-2.5-pro", "gemini-2.5-flash")


class ProposeRequest(BaseModel):
    intent: str
    verkada_connection_id: UUID | None = None
    gemini_connection_id: UUID | None = None
    # Answers to the questions asked before drafting.
    run_mode: str | None = None  # "webhook" | "schedule"
    # A real event of the kind that should trigger this. Grounding the
    # trigger in something that actually happened is what stops the model
    # proposing an unfiltered trigger that fires on everything.
    example_event_id: UUID | None = None
    # Or roughly when it last happened, if they don't want to browse.
    example_epoch: int | None = None


def _action_catalog() -> list[dict[str, Any]]:
    """The actions a flow may use, with their real config fields.

    Sourced from the live registry rather than a hand-maintained list, so
    a newly added action is immediately available to the builder and a
    removed one can't be proposed.
    """
    out: list[dict[str, Any]] = []
    for spec in ACTIONS.values():
        fields = []
        for f in (spec.schema or {}).get("fields", []):
            fields.append(
                {
                    "name": f.get("name"),
                    "type": f.get("type"),
                    "required": bool(f.get("required")),
                    "help": f.get("help"),
                    "options": f.get("options"),
                }
            )
        out.append(
            {
                "action_type": spec.type,
                "label": spec.label,
                "description": spec.description,
                "default_step_name": spec.default_step_name,
                "config_fields": fields,
            }
        )
    return out


def _examples() -> list[dict[str, Any]]:
    """The built-in templates, as worked examples of correct output."""
    examples: list[dict[str, Any]] = []
    if not TEMPLATE_DIR.is_dir():
        return examples
    for path in sorted(TEMPLATE_DIR.glob("*.json")):
        try:
            j = json.loads(path.read_text())
            # Only the parts that demonstrate correct structure.
            examples.append(
                {
                    "name": j.get("name"),
                    "summary": j.get("summary"),
                    "flow": j.get("flow"),
                }
            )
        except (OSError, json.JSONDecodeError) as e:  # noqa: BLE001
            logger.warning("skipping unreadable template %s: %s", path, e)
    return examples


async def _org_context(
    session: AsyncSession, conn_id: UUID | None
) -> dict[str, Any]:
    """Real devices from this org, so the model resolves names to IDs
    instead of inventing them."""
    cam_q = select(VerkadaCamera).order_by(VerkadaCamera.name.asc().nullslast())
    door_q = select(VerkadaDoor)
    helix_q = select(VerkadaHelixEventType)
    if conn_id is not None:
        cam_q = cam_q.where(VerkadaCamera.connection_id == conn_id)
        door_q = door_q.where(VerkadaDoor.connection_id == conn_id)
        helix_q = helix_q.where(VerkadaHelixEventType.connection_id == conn_id)
    cams = (await session.execute(cam_q)).scalars().all()
    doors = (await session.execute(door_q)).scalars().all()
    helix = (await session.execute(helix_q)).scalars().all()
    return {
        "cameras": [
            {
                "camera_id": c.camera_id,
                "name": c.name,
                "site": c.site,
                "status": c.status,
            }
            for c in cams
        ],
        "doors": [
            {"door_id": d.door_id, "name": d.name, "site": d.site} for d in doors
        ],
        "existing_helix_event_types": [
            {
                "event_type_uid": h.event_type_uid,
                "name": h.name,
                "schema": h.event_schema,
            }
            for h in helix
        ],
    }


PROMPT = """You design automation flows for vFusion, a tool that reacts to \
Verkada webhooks and camera footage.

Return ONE JSON object in exactly the shape of the worked examples below. \
No prose, no markdown fence.

Rules that matter:
- `action_type` MUST be one of the action catalog entries. Never invent one.
- Config keys MUST come from that action's config_fields. Leave every \
`connection_id` / `gemini_connection_id` as null — they are bound at install.
- `trigger_config.family` and `notification_type` MUST come from the taxonomy.
- Reference a real camera_id from the org context when the user names a \
camera. If the user's wording matches no camera, or matches several, leave \
the field as the template ref "{{ trigger.data.camera_id }}" and say so in \
`assumptions`.
- Downstream steps read earlier output with {{ steps.<name>.output.<field> }}, \
matching the step's `name`.
- If the flow should post to Helix and no existing event type fits, declare a \
new one in `helix_event_types` with a "tpl:" uid, as the examples do.
- Prefer the smallest flow that does the job.

Also return:
- "explanation": 1-2 sentences, plain language, what this flow does.
- "assumptions": array of strings — anything you guessed, and anything the \
user asked for that this flow does NOT do.

Important: vFusion posts events to Verkada Helix. It does not send phone \
notifications or emails. If the user asked to "be notified", put an \
assumption saying the alert itself is configured in Verkada Command on the \
Helix event this flow writes.

=== TRIGGER TAXONOMY ===
__TAXONOMY__

=== ACTION CATALOG ===
__ACTIONS__

=== THIS ORG'S DEVICES ===
__ORG__

=== WORKED EXAMPLES OF CORRECT OUTPUT ===
__EXAMPLES__

=== HOW IT SHOULD RUN ===
__RUNMODE__

=== USER REQUEST ===
__INTENT__
"""


def _warnings(flow: dict[str, Any]) -> list[str]:
    """Valid, but probably not what they meant.

    The one that matters: a camera-family trigger with no camera filter
    fires on every camera in the org, while the analyze step is pinned to
    one camera_id. That flow is legal, runs constantly, and analyses the
    wrong camera's footage every time something moves anywhere.
    """
    out: list[str] = []
    trig = flow.get("trigger_config") or {}
    filters = trig.get("filters") or {}
    if flow.get("trigger_type") == "verkada_webhook" and trig.get("family") == "camera":
        pinned = {
            str((n.get("config") or {}).get("camera_id"))
            for n in (flow.get("nodes") or [])
            if (n.get("config") or {}).get("camera_id")
            and "{{" not in str((n.get("config") or {}).get("camera_id"))
        }
        if pinned and not filters.get("camera_id"):
            out.append(
                "This triggers on motion from EVERY camera, but the steps are "
                f"pinned to {'one camera' if len(pinned) == 1 else 'specific cameras'}. "
                'Either add {"camera_id": "<id>"} to the trigger filters, or use '
                "{{ trigger.data.camera_id }} in the steps so it follows whichever "
                "camera fired."
            )
        if not filters:
            out.append(
                "The trigger has no filters, so every motion event runs this flow. "
                "If you only care about a subset (a person, a vehicle, an animal), "
                'add an objects filter — the animal template uses {"objects": "animal"}.'
            )
    return out


def _validate(tpl: dict[str, Any]) -> list[str]:
    """Check a proposed template against the live system. Returns errors."""
    errors: list[str] = []
    flow = tpl.get("flow")
    if not isinstance(flow, dict):
        return ["top-level 'flow' object is missing"]

    trig = flow.get("trigger_config") or {}
    family = trig.get("family")
    if flow.get("trigger_type") == "verkada_webhook":
        if family and family not in TAXONOMY:
            errors.append(
                f"trigger family {family!r} is not a real family "
                f"(valid: {', '.join(sorted(TAXONOMY))})"
            )
        nt = trig.get("notification_type")
        if family in TAXONOMY and nt:
            allowed = TAXONOMY[family].get("notification_types")
            if allowed and nt not in allowed:
                errors.append(
                    f"notification_type {nt!r} is not valid for family {family!r}"
                )

    nodes = flow.get("nodes") or []
    if not nodes:
        errors.append("flow has no nodes")
    names: set[str] = set()
    for n in nodes:
        nid = n.get("id") or n.get("name") or "<unnamed>"
        names.add(n.get("name") or "")
        if n.get("kind") == "condition":
            continue
        at = n.get("action_type")
        spec = ACTIONS.get(at)
        if spec is None:
            errors.append(
                f"step {nid!r} uses unknown action_type {at!r} "
                f"(valid: {', '.join(sorted(ACTIONS))})"
            )
            continue
        allowed_keys = {
            f.get("name") for f in (spec.schema or {}).get("fields", [])
        }
        for key in (n.get("config") or {}):
            if key not in allowed_keys:
                errors.append(
                    f"step {nid!r} ({at}) has config key {key!r}, which that "
                    f"action doesn't accept (valid: {', '.join(sorted(k for k in allowed_keys if k))})"
                )

    edges = flow.get("edges") or []
    ids = {n.get("id") for n in nodes}
    kinds = {n.get("id"): n.get("kind", "action") for n in nodes}

    # Unconnected steps are valid to the engine — every node with no
    # incoming edge is treated as a root and runs — but that is almost
    # never what someone meant by "then do X". Catch it here rather than
    # letting them wonder why the steps ran in parallel.
    if len(nodes) > 1 and not edges:
        errors.append(
            "steps aren't connected — add edges so they run in order "
            "instead of all firing independently"
        )
    for e in edges:
        if e.get("branch") and kinds.get(e.get("source")) != "condition":
            errors.append(
                f"edge from {e.get('source')!r} has branch "
                f"{e.get('branch')!r}, but only condition steps have branches"
            )

    # Cycles — the worker topologically sorts and would raise at runtime.
    indeg = {i: 0 for i in ids}
    out: dict[Any, list[Any]] = {i: [] for i in ids}
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if s not in ids or t not in ids:
            errors.append(f"edge {s!r}->{t!r} references a step that doesn't exist")
            continue
        indeg[t] += 1
        out[s].append(t)
    queue = [i for i in ids if indeg[i] == 0]
    seen = 0
    while queue:
        cur = queue.pop()
        seen += 1
        for nxt in out[cur]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
    if ids and seen != len(ids):
        errors.append("steps form a cycle — a flow must be a DAG")
    return errors


def _extract_json(text: str) -> dict[str, Any]:
    """Models fence JSON even when told not to. Strip and parse."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"no JSON object in model output: {text[:200]!r}")
    return json.loads(t[start : end + 1])


def _generate(api_key: str, prompt: str) -> tuple[str, str, int, int]:
    """Returns (text, model_that_answered, tokens_in, tokens_out).

    response_mime_type asks the API for JSON at the decoding level, which
    removes the whole class of "model wrapped it in a code fence" failures.
    max_output_tokens is generous because a truncated response is invalid
    JSON, and that reads as a model failure rather than a length problem.
    """
    from google import genai

    client = genai.Client(api_key=api_key)
    last: Exception | None = None
    for model in MODEL_CHAIN:
        try:
            res = client.models.generate_content(
                model=model,
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "max_output_tokens": 8192,
                },
            )
            text = res.text or ""
            if not text.strip():
                raise RuntimeError("model returned an empty response")
            usage = getattr(res, "usage_metadata", None)
            return (
                text,
                model,
                int(getattr(usage, "prompt_token_count", 0) or 0),
                int(getattr(usage, "candidates_token_count", 0) or 0),
            )
        except Exception as e:  # noqa: BLE001 — try the next model in the chain
            last = e
            continue
    raise RuntimeError(f"all Gemini models failed — last error: {last}")


async def _observed_step_costs(
    session: AsyncSession,
) -> dict[tuple[str, str], tuple[float, int]]:
    """Average observed cost per (action_type, model), from real runs.

    Every Gemini step already records `output.cost` with the real token
    counts the API reported, and the Stats page aggregates the same field.
    Reusing it means the estimate is what this org actually pays, rather
    than my arithmetic on published rates — same reasoning as replaying the
    trigger against real events instead of asserting it looks right.
    """
    rows = (
        await session.execute(
            select(Run.steps).order_by(Run.created_at.desc()).limit(RUN_HISTORY_LIMIT)
        )
    ).all()
    acc: dict[tuple[str, str], list[float]] = {}
    for (steps,) in rows:
        for step in steps or []:
            if not isinstance(step, dict):
                continue
            out = step.get("output")
            cost = out.get("cost") if isinstance(out, dict) else None
            if not isinstance(cost, dict):
                continue
            usd = float(cost.get("cost_usd") or 0)
            if usd <= 0:
                continue
            key = (str(step.get("type") or ""), str(cost.get("model") or ""))
            acc.setdefault(key, []).append(usd)
    return {k: (sum(v) / len(v), len(v)) for k, v in acc.items()}


def _estimate_run_cost(
    flow: dict[str, Any], observed: dict[tuple[str, str], tuple[float, int]]
) -> dict[str, Any]:
    """What one firing of this flow would cost, per step.

    Prefers the same action+model seen before; falls back to the same
    action on any model; otherwise reports unknown rather than inventing a
    number. Conditions and Helix posts are free — only the model calls cost.
    """
    per_step: list[dict[str, Any]] = []
    total = 0.0
    unknown = 0
    for node in flow.get("nodes") or []:
        at = node.get("action_type")
        if not at or not str(at).startswith("gemini"):
            continue
        model = str((node.get("config") or {}).get("model") or "")
        hit = observed.get((at, model))
        basis = f"{hit[1]} past runs of this action on {model}" if hit else None
        if hit is None:
            same_action = [
                (avg, n) for (a, _m), (avg, n) in observed.items() if a == at
            ]
            if same_action:
                runs = sum(n for _a, n in same_action)
                avg = sum(a * n for a, n in same_action) / runs
                hit = (avg, runs)
                basis = f"{runs} past runs of this action (other models)"
        if hit is None:
            unknown += 1
            per_step.append({"step": node.get("name"), "action_type": at, "usd": None})
            continue
        total += hit[0]
        per_step.append(
            {
                "step": node.get("name"),
                "action_type": at,
                "usd": round(hit[0], 6),
                "basis": basis,
            }
        )
    return {
        "per_firing_usd": round(total, 6) if per_step else 0.0,
        "steps": per_step,
        "unpriced_steps": unknown,
    }


def _replay_rows(
    rows: list[tuple[str, str | None, str | None, str | None, dict[str, Any]]],
    trigger_config: dict[str, Any],
) -> dict[str, Any]:
    """Pure-function replay over rows already pulled from the database.

    Split out so the streaming response doesn't hold a DB session open
    across a multi-second model call.
    """
    hits: list[dict[str, Any]] = []
    for rid, received, family, nt, body in rows:
        event = {
            "family": family,
            "notification_type": nt,
            "data": body.get("data") if isinstance(body.get("data"), dict) else {},
        }
        try:
            if trigger_matches(trigger_config, event):
                hits.append(
                    {
                        "id": rid,
                        "received_at": received,
                        "family": family,
                        "notification_type": nt,
                    }
                )
        except Exception:  # noqa: BLE001 — a bad filter shouldn't break the page
            continue
    stamps = [r[1] for r in rows if r[1]]
    span_days: float | None = None
    if len(stamps) >= 2:
        try:
            newest = datetime.fromisoformat(max(stamps))
            oldest = datetime.fromisoformat(min(stamps))
            span_days = max((newest - oldest).total_seconds() / 86400.0, 0.0) or None
        except ValueError:
            span_days = None
    return {
        "scanned": len(rows),
        "matched": len(hits),
        "samples": hits[:5],
        "span_days": span_days,
        "per_day": (len(hits) / span_days) if span_days else None,
    }


@router.get("/event-kinds")
async def event_kinds(
    limit: int = 4000,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Distinct kinds of webhook this org actually receives.

    Picking a *kind* beats picking a row: 2000 near-identical motion events
    are unusable as a list, but "alert_rule_motion on Front Door, 412 in the
    last week" is a thing someone can recognise. Each kind carries a
    representative event id, which is what grounds the trigger.
    """
    rows = (
        await session.execute(
            select(WebhookEvent)
            .order_by(WebhookEvent.received_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    # camera_id -> friendly name, so the list reads in human terms
    cams = {
        c.camera_id: c.name
        for c in (await session.execute(select(VerkadaCamera))).scalars().all()
    }

    kinds: dict[tuple[str, str, str], dict[str, Any]] = {}
    for r in rows:
        body = r.body_json if isinstance(r.body_json, dict) else {}
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        cam = str(data.get("camera_id") or "")
        key = (r.family or "?", r.notification_type or "?", cam)
        entry = kinds.get(key)
        if entry is None:
            objects = data.get("objects")
            kinds[key] = {
                "family": r.family,
                "notification_type": r.notification_type,
                "camera_id": cam or None,
                "camera_name": cams.get(cam),
                "door_name": (data.get("door_info") or {}).get("name")
                if isinstance(data.get("door_info"), dict)
                else None,
                "objects": objects if isinstance(objects, list) else None,
                "count": 0,
                "last_seen": r.received_at.isoformat() if r.received_at else None,
                "sample_event_id": str(r.id),
            }
            entry = kinds[key]
        entry["count"] += 1

    out = sorted(kinds.values(), key=lambda k: k["count"], reverse=True)
    return {"scanned": len(rows), "kinds": out[:60]}


async def _example_event(
    session: AsyncSession, event_id: UUID | None, epoch: int | None
) -> dict[str, Any] | None:
    """The event the trigger should be modelled on.

    Either one they picked, or the event closest to a timestamp they
    remember. Returns the classified shape plus the handful of data fields
    a trigger can filter on — not the whole payload, which would be mostly
    noise in the prompt.
    """
    row = None
    if event_id is not None:
        row = await session.get(WebhookEvent, event_id)
    elif epoch is not None:
        target = datetime.fromtimestamp(epoch, tz=timezone.utc)
        # Nearest on either side, so a rough guess still lands on something.
        before = (
            await session.execute(
                select(WebhookEvent)
                .where(WebhookEvent.received_at <= target)
                .order_by(WebhookEvent.received_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        after = (
            await session.execute(
                select(WebhookEvent)
                .where(WebhookEvent.received_at >= target)
                .order_by(WebhookEvent.received_at.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
        candidates = [c for c in (before, after) if c is not None]
        if candidates:
            row = min(
                candidates,
                key=lambda c: abs((c.received_at - target).total_seconds()),
            )
    if row is None:
        return None
    body = row.body_json if isinstance(row.body_json, dict) else {}
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    return {
        "received_at": row.received_at.isoformat() if row.received_at else None,
        "family": row.family,
        "notification_type": row.notification_type,
        "filterable_fields": {
            k: data.get(k)
            for k in (
                "camera_id",
                "door_id",
                "objects",
                "person_label",
                "license_plate_number",
                "direction",
            )
            if data.get(k) is not None
        },
    }


@router.post("/propose")
async def propose(
    payload: ProposeRequest,
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    """Draft a flow from a sentence, streaming progress as it goes.

    Emits newline-delimited JSON: a series of {"stage", "detail"} lines
    while it works, then one {"stage": "done", "result": {...}}. Building
    takes several seconds across two model calls, and a spinner that says
    nothing for that long reads as a hang.

    Everything touching the database is read up front so the session isn't
    held open for the duration of the stream.
    """
    intent = payload.intent.strip()
    if not intent:
        raise HTTPException(status_code=400, detail="Describe what you want built.")

    gemini = None
    if payload.gemini_connection_id:
        gemini = await session.get(Connection, payload.gemini_connection_id)
    if gemini is None:
        gemini = (
            await session.execute(
                select(Connection)
                .where(Connection.type == "gemini")
                .order_by(Connection.created_at.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if gemini is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "No Gemini connection configured. The flow builder uses the "
                "same Gemini key the analysis actions use — add one on the "
                "Connections page."
            ),
        )
    try:
        api_key = decrypt_secret(gemini.encrypted_secret).get("api_key")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decrypt secret: {e}")
    if not api_key:
        raise HTTPException(
            status_code=400, detail="That Gemini connection has no API key yet."
        )

    org = await _org_context(session, payload.verkada_connection_id)
    observed_costs = await _observed_step_costs(session)
    examples = _examples()
    catalog = _action_catalog()
    replay_rows = [
        (
            str(r.id),
            r.received_at.isoformat() if r.received_at else None,
            r.family,
            r.notification_type,
            r.body_json if isinstance(r.body_json, dict) else {},
        )
        for r in (
            await session.execute(
                select(WebhookEvent)
                .order_by(WebhookEvent.received_at.desc())
                .limit(REPLAY_LIMIT)
            )
        )
        .scalars()
        .all()
    ]
    conn_name = gemini.name

    example = await _example_event(
        session, payload.example_event_id, payload.example_epoch
    )
    if payload.run_mode == "schedule":
        run_mode_block = (
            "Use trigger_type \"schedule\". Pick a sensible interval for the task "
            "and say what you chose in assumptions. Do NOT use a webhook trigger."
        )
    elif example:
        run_mode_block = (
            "Use trigger_type \"verkada_webhook\". The user pointed at a REAL "
            "event of the kind that should fire this flow:\n"
            + json.dumps(example, indent=1)
            + "\n\nSet trigger_config.family and notification_type to match it "
            "exactly. Build trigger_config.filters from its filterable_fields so "
            "the flow fires on THIS kind of event and not on everything — if the "
            "event names a camera_id, filter on it, unless the user clearly wants "
            "every camera. Steps that act on the triggering camera should use "
            "{{ trigger.data.camera_id }} rather than hardcoding the id."
        )
    elif payload.run_mode == "webhook":
        run_mode_block = (
            "Use trigger_type \"verkada_webhook\". The user has no example event "
            "yet — this hasn't happened before. Choose the family and "
            "notification_type from the taxonomy, and add filters narrow enough "
            "that the flow doesn't fire on unrelated traffic. List in assumptions "
            "which trigger you chose and that it is unverified."
        )
    else:
        run_mode_block = (
            "The user didn't say how it should run. Choose whichever fits, and "
            "state the choice in assumptions."
        )

    # Deliberately not str.format(): the prompt contains literal {{ }}
    # template refs that format() would collapse to single braces.
    prompt = (
        PROMPT.replace(
            "__TAXONOMY__",
            json.dumps(
                {
                    k: {"notification_types": v.get("notification_types")}
                    for k, v in TAXONOMY.items()
                },
                indent=1,
            ),
        )
        .replace("__ACTIONS__", json.dumps(catalog, indent=1))
        .replace("__ORG__", json.dumps(org, indent=1)[:20000])
        .replace("__EXAMPLES__", json.dumps(examples, indent=1))
        .replace("__RUNMODE__", run_mode_block)
        .replace("__INTENT__", intent)
    )

    async def stream() -> Any:
        def line(**kw: Any) -> bytes:
            return (json.dumps(kw) + "\n").encode()

        yield line(
            stage="context",
            detail=(
                f"{len(org['cameras'])} cameras, {len(org['doors'])} doors, "
                f"{len(catalog)} action types, {len(examples)} example flows"
            ),
        )
        if example:
            yield line(
                stage="grounded",
                detail=(
                    f"trigger modelled on a real {example['notification_type']} "
                    f"event from {example['received_at']}"
                ),
            )
        elif payload.run_mode:
            yield line(stage="run-mode", detail=f"building a {payload.run_mode} trigger")
        yield line(
            stage="replay-ready",
            detail=f"{len(replay_rows)} past webhook events loaded to test against",
        )

        attempts: list[dict[str, Any]] = []
        draft_tokens_in = 0
        draft_tokens_out = 0
        tpl: dict[str, Any] | None = None
        errors: list[str] = []
        used_model = ""
        current = prompt

        # Two rounds. A parse failure retries like any other failure — an
        # earlier version treated it as fatal, so one malformed reply killed
        # the whole request.
        for attempt in range(2):
            yield line(
                stage="drafting",
                detail=(
                    f"asking {MODEL_CHAIN[0]} ({len(current) // 1000}k chars of context)"
                    if attempt == 0
                    else "sending the validation errors back for a fix"
                ),
            )
            try:
                raw, used_model, t_in, t_out = await asyncio.to_thread(
                    _generate, api_key, current
                )
                draft_tokens_in += t_in
                draft_tokens_out += t_out
                candidate = _extract_json(raw)
            except Exception as e:  # noqa: BLE001
                errors = [str(e)]
                attempts.append({"attempt": attempt + 1, "error": str(e)[:300]})
                yield line(stage="error", detail=str(e)[:300])
                continue
            yield line(stage="validating", detail=f"{used_model} answered")
            errors = _validate(candidate)
            attempts.append({"attempt": attempt + 1, "errors": errors})
            tpl = candidate
            if not errors:
                yield line(stage="valid", detail="draft passed validation")
                break
            yield line(
                stage="invalid",
                detail=f"{len(errors)} problem(s): {errors[0]}",
            )
            current = (
                prompt
                + "\n\n=== YOUR PREVIOUS ATTEMPT WAS INVALID ===\n"
                + json.dumps(candidate, indent=1)
                + "\n\nFix exactly these problems and return the corrected JSON:\n- "
                + "\n- ".join(errors)
            )

        if tpl is None:
            yield line(
                stage="done",
                result={
                    "intent": intent,
                    "template": {},
                    "valid": False,
                    "errors": errors or ["the model returned nothing usable"],
                    "attempts": attempts,
                    "replay": None,
                    "model": used_model,
                    "gemini_connection": conn_name,
                },
            )
            return

        flow = tpl.get("flow") or {}
        warnings = _warnings(flow)
        run_cost = _estimate_run_cost(flow, observed_costs)
        draft_cost = await cost_for(used_model, draft_tokens_in, draft_tokens_out)
        await ledger.record(
            used_model, draft_tokens_in, draft_tokens_out, source="Flow builder"
        )
        yield line(
            stage="pricing",
            detail=(
                f"draft used {draft_tokens_in + draft_tokens_out} tokens; "
                f"{run_cost['per_firing_usd']:.4f} USD per firing of this flow"
            ),
        )
        replay = None
        if flow.get("trigger_type") == "verkada_webhook":
            yield line(stage="replaying", detail="testing the trigger on real events")
            replay = _replay_rows(replay_rows, flow.get("trigger_config") or {})
            yield line(
                stage="replayed",
                detail=f"matched {replay['matched']} of {replay['scanned']}",
            )

        yield line(
            stage="done",
            result={
                "intent": intent,
                "template": tpl,
                "valid": not errors,
                "errors": errors,
                "attempts": attempts,
                "replay": replay,
                "warnings": warnings,
                "run_cost": run_cost,
                "draft_cost": {
                    "tokens_in": draft_tokens_in,
                    "tokens_out": draft_tokens_out,
                    "usd": float(draft_cost["cost_usd"]) if draft_cost else None,
                },
                "model": used_model,
                "gemini_connection": conn_name,
            },
        )

    return StreamingResponse(stream(), media_type="application/x-ndjson")
