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
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.schemas import TAXONOMY
from app.crypto import decrypt_secret
from app.db import get_session
from app.engine.actions import ACTIONS
from app.engine.triggers import matches as trigger_matches
from app.models import (
    Connection,
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

# Cheap and fast; the task is structured extraction against a rich prompt,
# not open-ended reasoning. Falls back down the chain on 503/429.
MODEL_CHAIN = ("gemini-2.5-flash", "gemini-2.0-flash")


class ProposeRequest(BaseModel):
    intent: str
    verkada_connection_id: UUID | None = None
    gemini_connection_id: UUID | None = None


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
                "output_sample": spec.output_sample,
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
            examples.append(json.loads(path.read_text()))
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

=== USER REQUEST ===
__INTENT__
"""


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


async def _replay(
    session: AsyncSession, trigger_config: dict[str, Any]
) -> dict[str, Any]:
    """Would this trigger have fired on real traffic?

    Uses the same matcher the live ingest path uses, so this is the actual
    firing decision rather than an approximation of it.
    """
    rows = (
        (
            await session.execute(
                select(WebhookEvent)
                .order_by(WebhookEvent.received_at.desc())
                .limit(REPLAY_LIMIT)
            )
        )
        .scalars()
        .all()
    )
    hits: list[dict[str, Any]] = []
    for row in rows:
        body = row.body_json if isinstance(row.body_json, dict) else {}
        event = {
            "family": row.family,
            "notification_type": row.notification_type,
            "data": body.get("data") if isinstance(body.get("data"), dict) else {},
        }
        try:
            if trigger_matches(trigger_config, event):
                hits.append(
                    {
                        "id": str(row.id),
                        "received_at": row.received_at.isoformat()
                        if row.received_at
                        else None,
                        "notification_type": row.notification_type,
                        "family": row.family,
                    }
                )
        except Exception:  # noqa: BLE001 — a bad filter shouldn't 500 the page
            continue
    return {
        "scanned": len(rows),
        "matched": len(hits),
        "samples": hits[:5],
    }


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


def _generate(api_key: str, prompt: str) -> str:
    from google import genai

    client = genai.Client(api_key=api_key)
    last: Exception | None = None
    for model in MODEL_CHAIN:
        try:
            res = client.models.generate_content(model=model, contents=prompt)
            return res.text or ""
        except Exception as e:  # noqa: BLE001 — try the next model in the chain
            last = e
            continue
    raise RuntimeError(f"all Gemini models failed: {last}")


@router.post("/propose")
async def propose(
    payload: ProposeRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Turn a sentence into a proposed flow template. Never saves."""
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
        .replace("__ACTIONS__", json.dumps(_action_catalog(), indent=1))
        .replace("__ORG__", json.dumps(org, indent=1)[:20000])
        .replace("__EXAMPLES__", json.dumps(_examples(), indent=1))
        .replace("__INTENT__", intent)
    )

    attempts: list[dict[str, Any]] = []
    tpl: dict[str, Any] | None = None
    errors: list[str] = []
    current = prompt
    # One repair round. If the model can't produce a valid flow twice, the
    # honest move is to show the errors rather than keep paying for retries.
    for attempt in range(2):
        try:
            raw = await asyncio.to_thread(_generate, api_key, current)
            candidate = _extract_json(raw)
        except Exception as e:  # noqa: BLE001
            attempts.append({"attempt": attempt + 1, "error": str(e)[:300]})
            errors = [f"model call failed: {e}"]
            break
        errors = _validate(candidate)
        attempts.append({"attempt": attempt + 1, "errors": errors})
        tpl = candidate
        if not errors:
            break
        current = (
            prompt
            + "\n\n=== YOUR PREVIOUS ATTEMPT WAS INVALID ===\n"
            + json.dumps(candidate, indent=1)
            + "\n\nFix exactly these problems and return the corrected JSON:\n- "
            + "\n- ".join(errors)
        )

    if tpl is None:
        raise HTTPException(
            status_code=502,
            detail=(errors[0] if errors else "the model returned nothing usable"),
        )

    flow = tpl.get("flow") or {}
    replay = None
    if flow.get("trigger_type") == "verkada_webhook":
        replay = await _replay(session, flow.get("trigger_config") or {})

    return {
        "intent": intent,
        "template": tpl,
        "valid": not errors,
        "errors": errors,
        "attempts": attempts,
        "replay": replay,
        "gemini_connection": gemini.name,
    }
