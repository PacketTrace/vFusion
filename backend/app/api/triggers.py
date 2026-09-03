"""Sample trigger fields for the variable picker UI.

Given a (family, notification_type), returns a flat list of every
templatable path the user could reference, with a real sample value
pulled from the most recent matching webhook. Paths are returned in
the shape templates expect: ``trigger.data.person_label``,
``trigger.org_id``, etc.
"""

from typing import Any, get_args, get_origin

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.connectors.verkada import poi_store
from app.connectors.verkada.schemas import (
    AccessEventData,
    AlarmSiteStateChangedData,
    CameraEventData,
    CredentialEventData,
    IntercomEventData,
    LPRData,
    NewAlarmEventData,
    SensorAlertData,
)
from app.models import WebhookEvent


router = APIRouter(prefix="/api/triggers", tags=["triggers"])


class TriggerField(BaseModel):
    path: str
    sample: Any
    type: str


def _flatten(value: Any, prefix: str, out: list[TriggerField]) -> None:
    """Walk a JSON value and emit (path, sample, type) for each scalar leaf."""
    if isinstance(value, dict):
        for k, v in value.items():
            child = f"{prefix}.{k}" if prefix else k
            _flatten(v, child, out)
    elif isinstance(value, list):
        # Show the array as a single entry with its length so the user knows it's there.
        out.append(
            TriggerField(path=prefix, sample=f"<array of {len(value)}>", type="array")
        )
        # Also walk the first element with [0] notation so nested fields are reachable.
        if value:
            _flatten(value[0], f"{prefix}.0", out)
    else:
        out.append(
            TriggerField(path=prefix, sample=value, type=type(value).__name__)
        )


# Samples that carry no useful info — frontend hides these as filter
# targets anyway, so we want a non-null sample to "win" over them if any
# other recent webhook has one.
_NULL_SAMPLES: tuple[Any, ...] = (None, "", "<array of 0>")


def _useful_sample(f: TriggerField) -> bool:
    return f.sample not in _NULL_SAMPLES


@router.get("/sample-fields", response_model=list[TriggerField])
async def sample_fields(
    family: str | None = Query(default=None),
    notification_type: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[TriggerField]:
    """Return every field path seen across the last ~20 matching webhooks.

    Verkada payloads vary inside a single notification_type — e.g.
    ``data.objects`` is populated on some ``alert_rule_motion`` fires and
    absent on others. Sampling only the most recent webhook would hide
    those fields from the filter picker, so we merge across recent
    events: any path that appears in any of them shows up, with the
    newest non-null sample winning as the value preview.
    """
    q = select(WebhookEvent).where(WebhookEvent.body_json.is_not(None))
    if family:
        q = q.where(WebhookEvent.family == family)
    if notification_type:
        q = q.where(WebhookEvent.notification_type == notification_type)
    q = q.order_by(desc(WebhookEvent.received_at)).limit(20)
    rows = (await session.execute(q)).scalars().all()

    # newest-first iteration → first non-null sample for each path wins.
    by_path: dict[str, TriggerField] = {}
    for row in rows:
        if not isinstance(row.body_json, dict):
            continue
        flat: list[TriggerField] = []
        _flatten(row.body_json, "trigger", flat)
        for f in flat:
            existing = by_path.get(f.path)
            if existing is None:
                by_path[f.path] = f
                continue
            # Upgrade a null/empty placeholder to a real value when we
            # find one further back in the history.
            if not _useful_sample(existing) and _useful_sample(f):
                by_path[f.path] = f

    out = list(by_path.values())
    # Sort: envelope fields first, then data.*, then everything else.
    def _rank(f: TriggerField) -> tuple[int, str]:
        p = f.path
        if p.startswith("trigger.data.") and p.count(".") == 2:
            return (1, p)
        if p.startswith("trigger.data."):
            return (2, p)
        if p.startswith("trigger.") and p.count(".") == 1:
            return (0, p)
        return (3, p)
    out.sort(key=_rank)
    return out


# ---------------------------------------------------------------------------
# Filter-field profiling
#
# The trigger filter picker used to offer a fixed per-family list — camera
# always got objects / person_label / license_plate_number / camera_id. That
# is wrong for most event types: `objects` is meaningless on camera_status,
# `person_label` on a crowd alert. And Verkada payloads carry noise, so a
# field appearing once in a thousand events shouldn't rank next to one
# present every time.
#
# So profile what actually arrives: for a given notification_type, how often
# each data.* field is populated, and which values it takes. Presence rate is
# the signal that separates a real filter from noise; observed values turn a
# free-text box into a picker.
# ---------------------------------------------------------------------------

# Fields that identify a specific event or moment rather than a class of
# them — filtering on these matches exactly one webhook, which is never
# what a trigger wants.
_NOT_FILTERABLE = {
    # Secret. On door_mobile_nfc_scan_accepted this is 100% populated and
    # holds the raw card bits; on door_code_entered_accepted it's the
    # keypad PIN. Offering it as a filter would print live credentials
    # into the picker as suggested values.
    "input_value",
    "raw_card",
    "rawCard",
    # Always constant for the selected event type — notification_type is
    # the picker above it, and device_type never varies within a family.
    "notification_type",
    "device_type",
    # Duplicate: device_id is camera_id on camera events and door_id on
    # access events, in every payload sampled.
    "device_id",
    "event_id",
    "created",
    "start_timestamp",
    "end_timestamp",
    "answered_timestamp",
    "image_url",
    "video_url",
    "crop",
    "detected",
    "confidence",
    "alert_event_id",
    "uuid",
}

# Above this many distinct values, offering a dropdown is pointless — it's
# an id or a timestamp, not a category.
_MAX_DISTINCT_FOR_PICKER = 25

# Fields whose complete value set is fixed by the API contract. Observation
# can only ever confirm a subset of these — a quiet camera makes "animal"
# look like it does not exist — so they are offered unconditionally.
_KNOWN_FIELD_VALUES: dict[str, list[str]] = {
    "objects": ["person", "vehicle", "animal"],
}


# The payload model behind each family. Alarm has two shapes, so the
# declared paths are the union -- a filter on a path the other shape
# lacks simply never matches, which is the same outcome as today.
_FAMILY_MODELS: dict[str, tuple[type[BaseModel], ...]] = {
    "camera": (CameraEventData,),
    "access": (AccessEventData,),
    "intercom": (IntercomEventData,),
    "lpr": (LPRData,),
    "sensor": (SensorAlertData,),
    "alarm": (AlarmSiteStateChangedData, NewAlarmEventData),
    "credential": (CredentialEventData,),
}


class FilterFieldProfile(BaseModel):
    field: str
    present: int
    sample_size: int
    present_pct: float
    # Distinct values seen, most common first. Empty when the field is
    # high-cardinality (ids, plates) — the UI falls back to free text.
    values: list[Any]
    distinct_count: int
    type: str
    # Values we know about from a Person of Interest sync that have never
    # appeared in a webhook. Somebody added to Command this morning is
    # filterable before they have ever walked past a camera.
    synced_values: list[Any] = []
    # Values that are part of the field's contract rather than something
    # we happened to record. Verkada's classifier only ever emits three
    # object classes, so "animal" should be pickable before an animal has
    # walked past a camera.
    known_values: list[Any] = []
    # True when the payload model declares this path. A declared path with
    # present == 0 is filterable but unproven; an undeclared one is a field
    # Verkada started sending that our schema has not caught up with.
    declared: bool = False


@router.get("/filter-fields", response_model=list[FilterFieldProfile])
async def filter_fields(
    family: str | None = Query(default=None),
    notification_type: str | None = Query(default=None),
    limit: int = Query(default=400, le=2000),
    session: AsyncSession = Depends(get_session),
) -> list[FilterFieldProfile]:
    """Which data.* paths are worth filtering on for this event type.

    Schema-first, observation-enriched. The candidate list comes from the
    Pydantic model for the family -- that is the contract, and it holds
    whether or not a matching webhook has arrived yet -- and the stored
    samples supply the evidence: how often each path is really populated
    and which values it takes.

    Observation alone was the original design and it hid working
    features. A field that is null in the last 400 samples is not a
    field that cannot be filtered, and an event type nobody has sent yet
    still has a known shape. Both used to come back as "no filters
    available", which reads as a limitation of the product rather than a
    gap in the data.
    """
    q = select(WebhookEvent).where(WebhookEvent.body_json.is_not(None))
    if family:
        q = q.where(WebhookEvent.family == family)
    if notification_type:
        q = q.where(WebhookEvent.notification_type == notification_type)
    q = q.order_by(desc(WebhookEvent.received_at)).limit(limit)
    rows = (await session.execute(q)).scalars().all()

    total = 0
    present: dict[str, int] = {}
    values: dict[str, dict[str, int]] = {}
    types: dict[str, str] = {}

    for row in rows:
        body = row.body_json if isinstance(row.body_json, dict) else {}
        data = body.get("data") if isinstance(body.get("data"), dict) else None
        if data is None:
            continue
        total += 1
        for path, raw in _walk(data):
            if isinstance(raw, list):
                types.setdefault(path, "array")
                present[path] = present.get(path, 0) + 1
                bucket = values.setdefault(path, {})
                for item in raw:
                    label = (
                        item.get("type") or item.get("label")
                        if isinstance(item, dict)
                        else item
                    )
                    if label is None:
                        continue
                    bucket[str(label)] = bucket.get(str(label), 0) + 1
                continue
            types.setdefault(path, type(raw).__name__)
            present[path] = present.get(path, 0) + 1
            bucket = values.setdefault(path, {})
            bucket[str(raw)] = bucket.get(str(raw), 0) + 1

    declared = _declared_paths(family)
    out: list[FilterFieldProfile] = []
    for path, count in present.items():
        bucket = values.get(path, {})
        distinct = len(bucket)
        top = [
            v for v, _n in sorted(bucket.items(), key=lambda kv: kv[1], reverse=True)
        ][:_MAX_DISTINCT_FOR_PICKER]
        out.append(
            FilterFieldProfile(
                field=path,
                present=count,
                sample_size=total,
                present_pct=round(100.0 * count / total, 1) if total else 0.0,
                values=top if distinct <= _MAX_DISTINCT_FOR_PICKER else [],
                distinct_count=distinct,
                type=types.get(path, "str"),
                declared=path in declared,
            )
        )

    # Everything the model promises but these samples never populated.
    # Offered anyway, flagged, so the UI can show it as unproven rather
    # than pretend the event has no such field.
    seen = {p.field for p in out}
    for path, kind in sorted(declared.items()):
        if path in seen:
            continue
        # user_info and friends are typed Any, so the schema knows the
        # field exists but not what is inside. Offer the container as a
        # placeholder only while we have no leaves for it -- once a
        # sample arrives, user_info.name is the useful thing and the
        # bare parent would never match a scalar anyway.
        if kind == "unknown" and any(o.startswith(f"{path}.") for o in seen):
            continue
        out.append(
            FilterFieldProfile(
                field=path,
                present=0,
                sample_size=total,
                present_pct=0.0,
                values=[],
                distinct_count=0,
                type=kind,
                declared=True,
            )
        )

    _merge_known_values(out)
    _merge_synced_people(out)
    out.sort(key=lambda f: (-f.present_pct, f.field))
    return out


def _walk(data: dict[str, Any], prefix: str = "", depth: int = 0):
    """Yield (dotted path, value) for every populated leaf in a payload.

    Descends one level into nested objects so ``door_info.name`` and
    ``user_info.email`` are offered as filters. The engine has always
    resolved dotted paths -- see ``engine.triggers._get`` -- so this
    exposes matching that already worked, it does not add it.

    Keys that are present but empty are skipped: a null tells us the
    field exists, which the schema already said, but gives the picker
    nothing to suggest.
    """
    for key, raw in data.items():
        if key in _NOT_FILTERABLE:
            continue
        path = f"{prefix}{key}"
        if raw is None or raw == "" or raw == []:
            continue
        if isinstance(raw, dict):
            if depth == 0:
                yield from _walk(raw, prefix=f"{path}.", depth=1)
            # A whole object is never compared as a unit; only its leaves.
            continue
        yield path, raw


def _declared_paths(family: str | None) -> dict[str, str]:
    """Path -> type name for everything the family's model declares.

    Nested models contribute their own fields as dotted paths. Fields
    typed ``Any`` (user_info, aux_info) are opaque here -- their inner
    keys can only come from samples, which is the one job observation
    still does better than the schema.
    """
    models = _FAMILY_MODELS.get(family or "", ())
    paths: dict[str, str] = {}
    for model in models:
        for name, info in model.model_fields.items():
            if name in _NOT_FILTERABLE:
                continue
            inner = _model_of(info.annotation)
            if inner is not None:
                for sub, sub_info in inner.model_fields.items():
                    if sub in _NOT_FILTERABLE:
                        continue
                    if _model_of(sub_info.annotation) is not None:
                        continue  # two levels deep is past useful
                    paths[f"{name}.{sub}"] = _type_name(sub_info.annotation)
                continue
            paths[name] = _type_name(info.annotation)
    return paths


def _model_of(annotation: Any) -> type[BaseModel] | None:
    """The BaseModel inside an annotation, seeing through ``X | None``."""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation
    for arg in get_args(annotation):
        if isinstance(arg, type) and issubclass(arg, BaseModel):
            return arg
    return None


def _type_name(annotation: Any) -> str:
    if get_origin(annotation) is list or annotation is list:
        return "array"
    args = [a for a in get_args(annotation) if a is not type(None)]
    target = args[0] if args else annotation
    if get_origin(target) is list or target is list:
        return "array"
    if target is Any:
        return "unknown"
    return getattr(target, "__name__", "str")


def _merge_known_values(profiles: list[FilterFieldProfile]) -> None:
    """Offer a field's documented values even when we have not seen them."""
    for profile in profiles:
        known = _KNOWN_FIELD_VALUES.get(profile.field)
        if not known:
            continue
        seen = {str(v).lower() for v in profile.values}
        profile.known_values = [v for v in known if v.lower() not in seen]


def _merge_synced_people(profiles: list[FilterFieldProfile]) -> None:
    """Add Person of Interest labels the webhook history has never shown.

    Observed values alone under-report badly: an org can have nine people
    enrolled and only two who have triggered an alert, and the seven
    others are exactly the ones somebody is likely to want a filter for.
    Kept separate from ``values`` so the UI can say where each came from.
    """
    known = poi_store.labels()
    if not known:
        return
    for profile in profiles:
        if profile.field != "person_label":
            continue
        seen = {str(v) for v in profile.values}
        profile.synced_values = [label for label in known if label not in seen]
