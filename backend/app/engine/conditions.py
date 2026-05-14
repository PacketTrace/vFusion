"""Condition node — evaluates a single boolean expression on the trigger
or any prior step's output, then gates downstream edges via
``branch="true"`` / ``branch="false"``.

For Phase 3b.4 we support one comparison per condition with these operators:
- ``equals`` / ``not_equals`` — case-insensitive when both sides are strings
- ``contains`` / ``not_contains`` — substring; case-insensitive
- ``exists`` / ``not_exists`` — non-empty / empty check on the left side
- ``gt`` / ``lt`` / ``gte`` / ``lte`` — numeric, lenient float parsing

Both sides accept ``{{ … }}`` template references; only the left side
is required.
"""

from typing import Any

from app.engine.templates import resolve_deep


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "left",
            "label": "Left value",
            "type": "text",
            "required": True,
            "help": 'Usually a {{ trigger.data.* }} or {{ steps.*.output.* }} reference.',
        },
        {
            "name": "operator",
            "label": "Operator",
            "type": "operator",
            "required": True,
        },
        {
            "name": "right",
            "label": "Right value",
            "type": "text",
            "required": False,
            "help": "Not used for exists / not_exists.",
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "kind": "condition",
    "matched": True,
    "left": "...",
    "operator": "equals",
    "right": "...",
}


OPERATORS = (
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "exists",
    "not_exists",
    "gt",
    "gte",
    "lt",
    "lte",
)


def _eq_ci(a: Any, b: Any) -> bool:
    if isinstance(a, str) and isinstance(b, str):
        return a.casefold() == b.casefold()
    return a == b


def _contains_ci(haystack: Any, needle: Any) -> bool:
    if not isinstance(haystack, str) or not isinstance(needle, str):
        return False
    return needle.casefold() in haystack.casefold()


def _try_float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _compare(left: Any, op: str, right: Any) -> bool:
    if op == "equals":
        return _eq_ci(left, right)
    if op == "not_equals":
        return not _eq_ci(left, right)
    if op == "contains":
        return _contains_ci(left, right)
    if op == "not_contains":
        return not _contains_ci(left, right)
    if op == "exists":
        return left is not None and left != "" and left != []
    if op == "not_exists":
        return left is None or left == "" or left == []
    a = _try_float(left)
    b = _try_float(right)
    if a is None or b is None:
        return False
    if op == "gt":
        return a > b
    if op == "gte":
        return a >= b
    if op == "lt":
        return a < b
    if op == "lte":
        return a <= b
    return False


def evaluate(config: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """Resolve both sides against ``ctx`` and compute the boolean result."""
    operator = (config.get("operator") or "equals").strip().lower()
    if operator not in OPERATORS:
        raise ValueError(f"unknown operator: {operator!r}")
    left = resolve_deep(config.get("left"), ctx)
    right = resolve_deep(config.get("right"), ctx)
    matched = _compare(left, operator, right)
    return {
        "kind": "condition",
        "matched": matched,
        "left": left,
        "operator": operator,
        "right": right,
    }
