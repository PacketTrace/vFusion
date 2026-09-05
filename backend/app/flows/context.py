"""What a model needs to know to reason about this install's flows.

Deliberately not a retrieval index. The action catalog is eight entries
and about eleven thousand characters -- it fits in a prompt with room to
spare, and injecting it outright has a property retrieval does not: it
cannot miss. A retriever that fails to surface an action produces a
model that invents one, and that failure looks like a plausible answer.

So the rule here is that everything bounded gets injected whole, and
only genuinely large corpora (the synced Verkada endpoint catalog, say)
would ever justify a search step.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine.actions import ACTIONS
from app.models import Flow, VerkadaCamera, VerkadaDoor, VerkadaHelixEventType


logger = logging.getLogger(__name__)


def action_catalog() -> list[dict[str, Any]]:
    """The actions a flow may use, with their real config fields.

    Sourced from the live registry rather than a hand-maintained list, so
    a newly added action is immediately available and a removed one
    cannot be proposed.
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


async def org_context(
    session: AsyncSession, conn_id: UUID | None
) -> dict[str, Any]:
    """Real devices from this org, so a model resolves names to IDs
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


# Names and triggers only. Enough to answer "do I already have something
# that does this?", which is the question worth answering once there are
# a few dozen; the full node configs would be most of the context window
# and add nothing to it.
async def existing_flows(session: AsyncSession) -> list[dict[str, Any]]:
    rows = (
        await session.execute(select(Flow).order_by(Flow.name.asc()))
    ).scalars().all()
    return [
        {
            "name": f.name,
            "enabled": bool(f.enabled),
            "trigger_type": f.trigger_type,
            "trigger": f.trigger_config or {},
            "steps": [
                n.get("action_type") for n in (f.nodes or []) if isinstance(n, dict)
            ],
        }
        for f in rows
    ]


def as_prompt_block(label: str, value: Any, limit: int = 24000) -> str:
    """One labelled section of context, truncated with a visible note.

    Truncation says so rather than trailing off: a model that reads a
    half-sentence of JSON treats it as the whole story, and so does
    whoever is reading the answer.
    """
    text = json.dumps(value, indent=1, default=str)
    if len(text) > limit:
        text = text[:limit] + f"\n… truncated at {limit} characters"
    return f"=== {label} ===\n{text}"
