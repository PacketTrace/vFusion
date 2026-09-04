"""Turning a described integration into a Helix type and a data spec.

Sibling of the analytic composer in ``api/byoa.py`` and deliberately
shaped like it, but answering a different question. That one asks a
vision model to look at a frame; this one has no camera in it at all --
it invents the shape of a system that is not connected yet, so a
customer can see what their timeline would look like if it were.

The model returns a schema and a description of the data, never the
data. See ``generate.py`` for why.
"""

from __future__ import annotations

import json as _json
from typing import Any


COMPOSE_MODELS = ("gemini-2.5-pro", "gemini-2.5-flash")


COMPOSE_PROMPT = """You design realistic sample data for Verkada Helix.

Helix attaches structured events to a camera's timeline. Someone is
about to demonstrate an integration that does not exist yet -- a
point-of-sale system, a warehouse scanner, a visitor log -- and needs
a Helix event type plus enough believable events to make the timeline
look real.

They described it like this:

__INTENT__

Return two things that fit together: the event type, and a
specification for generating events against it. Do NOT return any
events. A generator expands the specification, so describe the shape of
the data rather than listing rows.

Rules that matter:
- 3 to 5 attributes. Fewer and the demo is thin; more and a Helix row
  is unreadable.
- Every Helix attribute type is "string". Numbers, money and booleans
  are all strings.
- Attribute names are Title Case and human readable.
- Every attribute must have a field in the spec, and every field must
  name an attribute. No orphans either way.
- Values must be plausible for the described business. Real product
  names, real-looking codes, sensible prices. Generic placeholders like
  "Item A" make the demo worse than no demo.
- Make the row hang together. If there is a quantity and a total, give
  the total "scales_with": the quantity's attribute name so they agree.
  Use "count_from" the same way for lists.
- Only depend one level deep: a field that scales from another must not
  itself be depended upon.
- Rare things should be rare. A discount code on every sale is not what
  a shop looks like -- use weights.

Field kinds available:
  {"kind": "choice", "values": [...], "weights": [...]}
  {"kind": "int",   "min": 1, "max": 12, "skew": "low"}
  {"kind": "money", "min": 3.5, "max": 240, "scales_with": "Item Count",
                    "scale_base": 4}
  {"kind": "sample_from", "pool": [...], "count_from": "Item Count"}
  {"kind": "text",  "values": [...], "weights": [...]}
  {"kind": "bool",  "rate": 0.15}

"skew": "low" means most values sit near the minimum, which is what
basket sizes, queue lengths and durations actually look like.
"scale_base" is the quantity at which a scaled value sits mid-range.

Respond with ONLY this JSON object:

{
  "name": "short name for this demo, Title Case",
  "summary": "one sentence on what this integration would be",
  "helix_event_type": {
    "name": "Helix event type name, may start with one emoji",
    "event_schema": {"Attribute Name": "string"}
  },
  "spec": {
    "fields": {"Attribute Name": {"kind": "...", ...}},
    "timing": {
      "shape": "business",
      "open_hours": [9, 21],
      "peaks": [12, 18],
      "weekends": true
    }
  }
}
"""


def compose(api_key: str, intent: str) -> tuple[dict[str, Any], str]:
    """Generate a type and a spec. Returns (parsed, model that answered)."""
    from google import genai

    prompt = COMPOSE_PROMPT.replace("__INTENT__", intent.strip())
    client = genai.Client(api_key=api_key)
    last: Exception | None = None
    for model in COMPOSE_MODELS:
        try:
            res = client.models.generate_content(
                model=model,
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "max_output_tokens": 4096,
                },
            )
            text = (res.text or "").strip()
            if not text:
                raise RuntimeError("model returned an empty response")
            return _json.loads(text), model
        except Exception as e:  # noqa: BLE001 — try the next model
            last = e
            continue
    raise RuntimeError(f"could not compose a demo: {last}")


def validate(data: Any) -> dict[str, Any]:
    """Reject a type and a spec that do not describe the same thing.

    The same reasoning as the analytic composer: an attribute with no
    field generates blank, a field with no attribute is silently dropped,
    and both failures only surface as a disappointing timeline after
    several hundred events have been posted. Catching it here costs one
    retry.
    """
    if not isinstance(data, dict):
        raise ValueError("model did not return an object")

    et = data.get("helix_event_type")
    if not isinstance(et, dict) or not isinstance(et.get("event_schema"), dict):
        raise ValueError("missing helix_event_type.event_schema")
    schema: dict[str, Any] = et["event_schema"]
    if not schema:
        raise ValueError("event type has no attributes")

    spec = data.get("spec")
    if not isinstance(spec, dict) or not isinstance(spec.get("fields"), dict):
        raise ValueError("missing spec.fields")
    fields: dict[str, Any] = spec["fields"]

    missing = [a for a in schema if a not in fields]
    if missing:
        raise ValueError(f"attributes with no generator field: {', '.join(missing)}")
    extra = [f for f in fields if f not in schema]
    if extra:
        raise ValueError(f"generator fields with no attribute: {', '.join(extra)}")

    # Helix stores strings and nothing else, whatever the model says.
    et["event_schema"] = {name: "string" for name in schema}

    # A dependency that names a field which does not exist would silently
    # fall back to an unscaled random value -- the exact incoherence the
    # spec exists to prevent.
    for name, field in fields.items():
        if not isinstance(field, dict):
            raise ValueError(f"field {name} is not an object")
        for key in ("scales_with", "count_from"):
            ref = field.get(key)
            if ref and ref not in fields:
                raise ValueError(f"field {name} {key} names {ref}, which does not exist")
            if ref == name:
                raise ValueError(f"field {name} {key} refers to itself")

    data["name"] = str(data.get("name") or et.get("name") or "Helix demo")
    data["summary"] = str(data.get("summary") or "")
    spec.setdefault("timing", {"shape": "business"})
    return data
