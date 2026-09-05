"""Everything vFusion knows about itself, assembled from itself.

The requirement was help that is always right about what exists, how it
really works, and what is not possible. A written manual cannot be that:
it is correct on the day it is written and quietly wrong afterwards, and
the questions people ask are exactly the ones where "quietly wrong"
costs an hour.

So the corpus is built from the source at runtime. Module and function
docstrings, which in this codebase are where the constraints live —
what a thing refuses to do and why — plus the live action registry, the
route table, and the README and SECURITY documents. Change the code and
the help changes with it, because there is no second copy to update.

It is injected whole rather than retrieved from. It comes to roughly
fifty thousand tokens, which fits a 1M-context model with room to
spare, and injection cannot miss. A retriever that fails to surface the
paragraph explaining that vFusion does not send email produces a
confident "yes it does" — which is worse than no help at all, and
indistinguishable from good help until someone acts on it.
"""

from __future__ import annotations

import ast
import logging
from functools import lru_cache
from pathlib import Path


logger = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = APP_DIR.parent.parent

# Read whole. Small enough that trimming would cost more in missing
# answers than it saves in tokens.
DOC_FILES = ("README.md", "SECURITY.md")

# Docstrings shorter than this are labels, not explanations — "Returns
# the flow." adds a line of noise and no knowledge.
MIN_DOCSTRING = 40


# Product invariants, injected before everything else.
#
# The corpus is 51k tokens of implementation docstrings, and the true
# answer to a common question can be one paragraph buried in the middle
# of it. Asked "how do I get notified", the assistant found the
# mechanism — flows, triggers, the verkada_helix_event action — and
# answered with that, which is correct and not what anyone wanted to
# know. The answer is "vFusion writes a Helix event; you configure the
# alert on it in Command", and it should not have to be inferred.
#
# These are deliberately invariants rather than an FAQ. Each is true
# regardless of what the code does this week, and if one stops being
# true that is a product decision somebody made on purpose — not drift.
# Anything that changes with the code stays in the docstrings, where it
# cannot go stale.
KEY_FACTS = """### The short answers to the questions people actually ask

**Getting notified.** vFusion does not send notifications. It writes an
event to Verkada Helix; you then configure an alert on that Helix event
type inside Verkada Command, and Command sends the notification. There
is no email, SMS or push anywhere in vFusion, and no setting that adds
one. Anyone asking to "be told when X happens" needs: a flow that writes
a Helix event, then an alert on that event type in Command.

**Flows versus analytics.** A flow is a whole automation — a trigger,
some steps, usually a Helix event at the end. An analytic is only the
"what to look for" half: a prompt plus the Helix event type it writes
into, with no trigger. You run an analytic on the Workbench, or pick it
inside a flow's analysis step.

**Nothing runs until it is enabled.** A drafted, imported or
template-installed flow is created disabled. Enabling it is always a
deliberate act.

**What can start a flow.** A Verkada webhook, or a schedule. vFusion
cannot poll Verkada for arbitrary changes, and cannot react to something
Verkada does not send a webhook for.

**One Gemini key does everything.** Analysis steps, drafting flows,
composing analytics and demo data, this help, and video generation all
use the single Gemini connection.

**Where things are.** Webhook Explorer is incoming events. Automate holds
flow templates, analytics, your existing flows and their runs. Workbench
has the analytics builder, the API runner and video generation. Helix
manages event types and demo data. Virtual camera serves footage to a
Command Connector. MQTT is object-position streaming. Settings has
Connections, Retention, Security and Stats.

**Verkada's 403.** The API answers 403 both for a key that lacks a scope
and for a path it does not serve, so a 403 does not tell you which.
"""

def _python_knowledge() -> list[str]:
    """Module and definition docstrings, labelled by where they live."""
    out: list[str] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        rel = path.relative_to(APP_DIR.parent)
        module_doc = ast.get_docstring(tree)
        parts: list[str] = []
        if module_doc and len(module_doc) >= MIN_DOCSTRING:
            parts.append(module_doc.strip())
        for node in ast.walk(tree):
            if not isinstance(
                node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            ):
                continue
            doc = ast.get_docstring(node)
            if doc and len(doc) >= MIN_DOCSTRING:
                parts.append(f"[{node.name}] {doc.strip()}")
        if parts:
            out.append(f"### {rel}\n" + "\n\n".join(parts))
    return out


def _actions() -> str:
    """The steps a flow can actually contain."""
    try:
        from app.engine.actions import ACTIONS
    except Exception:  # noqa: BLE001
        return ""
    lines = ["### Flow actions (the complete list — there are no others)"]
    for spec in ACTIONS.values():
        fields = ", ".join(
            str(f.get("name"))
            for f in (spec.schema or {}).get("fields", [])
            if f.get("name")
        )
        lines.append(
            f"- {spec.type} — {spec.label}. {spec.description or ''} "
            f"Config: {fields or 'none'}."
        )
    return "\n".join(lines)


def _routes() -> str:
    """Every HTTP endpoint, so "is there an API for X" is answerable."""
    try:
        from app.main import app
    except Exception:  # noqa: BLE001
        return ""
    lines = ["### HTTP endpoints"]
    seen: set[str] = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue
        for method in sorted(m for m in methods if m not in ("HEAD", "OPTIONS")):
            key = f"{method} {path}"
            if key in seen:
                continue
            seen.add(key)
            summary = (getattr(route, "summary", None) or "").strip()
            lines.append(f"- {key}{f' — {summary}' if summary else ''}")
    return "\n".join(lines)


def _docs() -> list[str]:
    out: list[str] = []
    for name in DOC_FILES:
        path = REPO_DIR / name
        try:
            out.append(f"### {name}\n{path.read_text(encoding='utf-8')}")
        except OSError:
            continue
    return out


@lru_cache(maxsize=1)
def build(_cache_key: str) -> str:
    """Assemble the corpus. Keyed on the build id so it rebuilds exactly
    when the source does and not once per question."""
    sections = [
        # First, and deliberately: the model reads in order, and the
        # short true answer should not be competing with an
        # implementation note four hundred paragraphs later.
        KEY_FACTS,
        *_docs(),
        _actions(),
        _routes(),
        *_python_knowledge(),
    ]
    return "\n\n".join(s for s in sections if s.strip())


def current() -> str:
    from app.build_info import build_id

    return build(build_id())


def size() -> int:
    return len(current())
