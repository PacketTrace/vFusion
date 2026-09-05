"""What a flow template is, read off the flow itself.

The Templates page used to filter on hand-written ``tags``. That broke
at eight templates: every one of them carried "Cameras", so the chip
that looked like a filter matched everything and narrowed nothing, and
nobody would have noticed until the list was long enough for it to
matter.

A tag is a promise someone has to keep on every new file. These are
facts about the flow, computed from the nodes and the trigger, so a
template cannot be filed wrong and a new one is categorised the moment
it exists. Nothing here needs maintaining when a template is added --
only when an *action type* is added, which is the honest coupling.
"""

from __future__ import annotations

from typing import Any


# What the terminal actions of a flow accomplish, in the words someone
# picking a template would use. Actions with no entry contribute nothing
# rather than a generic "does something", which would be noise.
_DOES: dict[str, str] = {
    "verkada_helix_event": "Logs to Helix",
    "verkada_unlock_door": "Unlocks a door",
    "verkada_activate_scenario": "Activates a scenario",
    "verkada_release_scenario": "Releases a scenario",
    "verkada_api_call": "Calls the Verkada API",
}

# Which analytic an action is, if it is one. Drives the "Vision"/"Audio"
# facet -- the same medium split the prompt picker uses, for the same
# reason: they are not interchangeable.
_MEDIUM: dict[str, str] = {
    "gemini_analyze_camera": "Vision",
    "gemini_analyze_still_image": "Vision",
    "gemini_analyze_video": "Vision",
    "gemini_analyze_audio": "Audio",
}

# An action that cannot run without a credential the operator may not
# have yet. "Which of these work without a Gemini key" is a real
# question on first boot and the page could not answer it.
_NEEDS: dict[str, str] = {
    "gemini_analyze_camera": "Gemini",
    "gemini_analyze_still_image": "Gemini",
    "gemini_analyze_video": "Gemini",
    "gemini_analyze_audio": "Gemini",
    "weather_fetch": "Weather",
}

# Webhook event types, in operator words. Anything not listed falls back
# to the raw notification_type rather than being dropped -- an unknown
# event is still a real distinction between two templates.
_EVENT_LABELS: dict[str, str] = {
    "alert_rule_motion": "Motion",
    "person_of_interest": "Person of interest",
    "license_plate_of_interest": "Plate of interest",
    "lpr": "Licence plate",
    "door_opened": "Door opened",
    "door_closed": "Door closed",
    "door_locked": "Door locked",
    "door_unlocked": "Door unlocked",
    "door_code_entered_accepted": "Door code entered",
    "door_remote_unlock_accepted": "Remote unlock",
    "door_schedule_override_removed": "Schedule override",
    "intercom_call_triggered": "Intercom call",
    "sensor_alert": "Sensor alert",
}


def _action_types(flow: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for node in flow.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        if node.get("kind") == "condition":
            continue
        t = node.get("action_type")
        if isinstance(t, str) and t:
            out.append(t)
    return out


def _dedupe(values: list[str]) -> list[str]:
    """Order-preserving. The order actions appear in is the order the
    flow runs them, which reads better than alphabetical."""
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def starts_with(flow: dict[str, Any]) -> dict[str, str]:
    """The primary grouping axis: what sets this flow off.

    Returns a ``group`` (the section heading) and a ``detail`` (the
    specific event, when there is one). Trigger is the right primary
    axis because it is the first thing somebody knows about the
    automation they want -- "when a person shows up" or "every hour".
    """
    trigger = str(flow.get("trigger_type") or "")
    config = flow.get("trigger_config") or {}
    if trigger == "schedule":
        return {"group": "On a schedule", "detail": "Schedule"}
    if trigger == "verkada_webhook":
        nt = config.get("notification_type")
        detail = _EVENT_LABELS.get(str(nt), str(nt)) if nt else "Any camera event"
        return {"group": "When something happens", "detail": detail}
    if not trigger:
        return {"group": "Other", "detail": "Manual"}
    return {"group": "Other", "detail": trigger.replace("_", " ").title()}


def facets(flow: dict[str, Any]) -> dict[str, Any]:
    """Everything the Templates page filters and groups on."""
    if not isinstance(flow, dict):
        flow = {}
    actions = _action_types(flow)
    needs = _dedupe([_NEEDS[a] for a in actions if a in _NEEDS])
    # Every template here talks to Verkada; saying so on all of them
    # would repeat the "Cameras" mistake exactly. It is only worth
    # stating as the *absence* of anything else, which the UI renders
    # as "Verkada only".
    return {
        "starts": starts_with(flow),
        "needs": needs,
        "does": _dedupe([_DOES[a] for a in actions if a in _DOES]),
        "media": _dedupe([_MEDIUM[a] for a in actions if a in _MEDIUM]),
        "action_types": _dedupe(actions),
        "step_count": len(actions),
    }
