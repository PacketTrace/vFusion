"""Template substitution for flow action configs.

Lets a flow config reference trigger data via ``{{ trigger.data.path }}``
syntax. Resolves the path against a context dict at run time.

Two semantics:
- Whole-value substitution: if the field's value is exactly one
  ``{{ ... }}`` expression, the *raw* resolved value is returned (could
  be a dict, int, bool, etc.) so downstream code gets the right type.
- In-string interpolation: ``"hello {{ trigger.data.person_label }}"``
  becomes ``"hello Casey"``. Resolved values are stringified.

Walks lists/dicts recursively so the full action config tree gets
processed in one call.
"""

from __future__ import annotations

import re
from typing import Any


_TEMPLATE_RE = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")
_WHOLE_TEMPLATE_RE = re.compile(r"^\s*\{\{\s*([\w.]+)\s*\}\}\s*$")


def _lookup(path: str, ctx: dict[str, Any]) -> Any:
    cur: Any = ctx
    for key in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(key)
        elif isinstance(cur, list):
            try:
                cur = cur[int(key)]
            except (ValueError, IndexError):
                return None
        else:
            return None
        if cur is None:
            return None
    return cur


def resolve(value: Any, ctx: dict[str, Any]) -> Any:
    """Resolve one value. Strings get template substitution; everything
    else is returned as-is. Use ``resolve_deep`` to walk a nested config."""
    if not isinstance(value, str):
        return value

    whole = _WHOLE_TEMPLATE_RE.match(value)
    if whole:
        return _lookup(whole.group(1), ctx)

    def _replace(m: re.Match[str]) -> str:
        v = _lookup(m.group(1), ctx)
        return "" if v is None else str(v)

    return _TEMPLATE_RE.sub(_replace, value)


def resolve_deep(value: Any, ctx: dict[str, Any]) -> Any:
    """Resolve templates anywhere inside a dict/list/scalar."""
    if isinstance(value, dict):
        return {k: resolve_deep(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_deep(v, ctx) for v in value]
    return resolve(value, ctx)
