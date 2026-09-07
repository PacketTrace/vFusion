"""Match an incoming webhook against a flow's trigger configuration.

We support one trigger type — ``verkada_webhook`` — with the config shape::

    {
        "family": "camera",                        # required
        "notification_type": "person_of_interest", # optional
        "filters": {                               # optional, all-must-match
            "person_label": "Casey",
            "user_info.first_name": "Casey",       # dot paths into nested objects
            "door_info.name": "Garage Entry"
        }
    }

Filter keys are dot-separated paths inside ``data``. Values are
case-insensitive equality matches against the resolved leaf. Anything
fancier (substring / regex / comparison) lives in the condition node.
"""

from typing import Any


def _get(data: Any, path: str) -> Any:
    """Walk a dot-separated path into nested dicts. Returns None if any
    segment is missing or hits a non-dict value."""
    cur: Any = data
    for key in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            return None
        if cur is None:
            return None
    return cur


def _eq_ci(a: Any, b: Any) -> bool:
    if isinstance(a, str) and isinstance(b, str):
        return a.casefold() == b.casefold()
    # Filter values arrive from a text field. A status code of 403 has
    # to match "403".
    if isinstance(a, (int, float)) and not isinstance(a, bool) and isinstance(b, str):
        return str(a) == b.strip()
    if isinstance(a, bool) and isinstance(b, str):
        return str(a).casefold() == b.strip().casefold()
    return a == b


def _value_matches(actual: Any, expected: Any) -> bool:
    """An array field "matches" when any element equals the expected value
    (case-insensitive for strings). Scalar fields fall back to equality.
    Lets users filter on things like ``objects`` (which is a list of
    detected labels) against a single string like ``"animal"``."""
    if isinstance(actual, list):
        return any(_eq_ci(item, expected) for item in actual)
    return _eq_ci(actual, expected)


def matches(trigger_config: dict[str, Any], event: dict[str, Any]) -> bool:
    """Return True if the event satisfies the trigger's family / type / filters.

    ``event`` is the classified payload metadata, not the raw envelope::

        {
            "family": "camera",
            "notification_type": "person_of_interest",
            "data": {...}        # envelope.data
        }
    """
    want_family = trigger_config.get("family")
    if want_family and event.get("family") != want_family:
        return False

    want_nt = trigger_config.get("notification_type")
    if want_nt and event.get("notification_type") != want_nt:
        return False

    filters = trigger_config.get("filters") or {}
    data = event.get("data") or {}
    for field, expected in filters.items():
        if expected in (None, ""):
            continue  # empty filter — ignore
        if not _value_matches(_get(data, field), expected):
            return False
    return True


def matches_audit(trigger_config: dict[str, Any], payload: dict[str, Any]) -> bool:
    """The ``verkada_audit`` trigger: an audit-log row, as built by
    ``app.audit.ingest.trigger_payload``. Config shape::

        {
            "category": "cameras",              # optional, any if empty
            "event_name": "Live Stream Started",# optional
            "actor": "user",                    # optional: user | api_key | support | system
            "include_self": false,              # rows from this install's own key
            "filters": {                        # optional, all-must-match, dot paths
                "user_email": "casey@example.com",
                "data.device_name": "Front Door",
                "data.url": "/cameras/v1/devices",
                "status_code": "403"
            }
        }

    Paths resolve against the whole payload: who/when/what at the top,
    the target device and Verkada's ``details`` under ``data``.
    """
    want = trigger_config.get("category")
    if want and payload.get("category") != want:
        return False
    want = trigger_config.get("event_name")
    if want and not _eq_ci(payload.get("event_name"), want):
        return False
    want = trigger_config.get("actor")
    if want and payload.get("actor") != want:
        return False
    if payload.get("is_self") and not trigger_config.get("include_self"):
        return False
    for field, expected in (trigger_config.get("filters") or {}).items():
        if expected in (None, ""):
            continue
        if not _value_matches(_get(payload, field), expected):
            return False
    return True
