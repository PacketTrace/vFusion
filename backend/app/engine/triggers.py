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
