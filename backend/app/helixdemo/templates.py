"""Ready-made demo scenarios, so a demo does not need a model call.

Composing works, but it costs a Gemini round trip, takes a few seconds,
and produces something slightly different every time — none of which you
want when you are standing in front of a customer and just need a
plausible point-of-sale timeline on a camera.

These are the same shape the composer produces, hand-written and
checked, so they load instantly and read identically every time. They
are still a starting point: pick one, then use the adjust box to make
its products yours.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app.helixdemo import generate


logger = logging.getLogger(__name__)

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "data" / "demo_templates"

# Rows shown in the preview. Same count and seed as a composed draft, so
# picking a template and composing one look alike.
SAMPLE_ROWS = 5


def load_all() -> list[dict[str, Any]]:
    """Every template on disk, with a preview generated from its spec.

    Generated rather than stored: a hand-written sample would drift from
    the spec the moment either changed, and the preview's whole job is
    to show what the spec actually produces.
    """
    out: list[dict[str, Any]] = []
    if not TEMPLATE_DIR.is_dir():
        return out
    for path in sorted(TEMPLATE_DIR.glob("*.json")):
        try:
            tpl = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:  # noqa: BLE001
            logger.warning("skipping unreadable demo template %s: %s", path, e)
            continue
        if not isinstance(tpl, dict) or "spec" not in tpl:
            continue
        try:
            sample = generate.build_events(
                tpl["spec"], count=SAMPLE_ROWS, window_days=1, seed=0
            )
        except Exception as e:  # noqa: BLE001 — a bad template must not
            # take the whole list down with it.
            logger.warning("demo template %s could not generate: %s", path, e)
            continue
        out.append(
            {
                "id": path.stem,
                **tpl,
                "sample": [
                    {"attributes": e["attributes"], "at": e["at"].isoformat()}
                    for e in sample
                ],
            }
        )
    return out
