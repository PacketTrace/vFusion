"""Gemini spend that did not happen inside a flow run.

The Stats page sums ``output.cost`` off every run step, which was the
whole story when the engine was the only thing holding an API key. It
is not any more. Composing an analytic, composing a Helix demo,
building a flow from a description and a Workbench dry-run all bill to
the same Google account and none of them create a run, so the page
reported a number that was low by however much design work had been
done that month -- and low in the least useful direction, since prompt
iteration is exactly the spend an operator is trying to keep an eye on.

A file rather than a table, for the same reason as every other store
here: this is append-only bookkeeping, not relational data, and it is
not worth a migration. One JSON object per line on the assets volume.

Recording is best-effort by design. Nobody should lose a composed
analytic because the accounting for it could not be written down.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.pricing.gemini import cost_for


logger = logging.getLogger(__name__)

STORE_PATH = Path(
    os.environ.get("GEMINI_LEDGER_FILE", "/app/data/gemini/spend.jsonl")
)

# Stats asks for 30 days. Keeping twice that leaves room to widen the
# window later without having already thrown the answer away, and still
# bounds the file at a few thousand lines on a busy install.
RETENTION_DAYS = 60

# Only worth rewriting the file to drop old lines once there are enough
# of them to matter. Below this it is churn for nothing.
TRIM_THRESHOLD = 400

_lock = asyncio.Lock()


def usage_of(res: Any) -> tuple[int, int]:
    """(prompt tokens, response tokens) from a google-genai response.

    Defensive about the shape: a missing usage block should cost the
    caller a zero, not an AttributeError in the middle of returning a
    result the operator is waiting for.
    """
    usage = getattr(res, "usage_metadata", None)
    return (
        int(getattr(usage, "prompt_token_count", 0) or 0),
        int(getattr(usage, "candidates_token_count", 0) or 0),
    )


async def record_usd(
    model: str, cost_usd: float, *, source: str, units: str = ""
) -> None:
    """Note spend that is not priced in tokens.

    Video is billed per second of output, so the token path cannot price
    it — and video is the most expensive thing in the product, which
    makes it the worst thing to leave off the page. The entry carries
    zero tokens and a cost computed by the caller from the published
    per-second rate, plus a note of what was bought.
    """
    try:
        entry = {
            "at": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "model": model,
            "tokens_in": 0,
            "tokens_out": 0,
            "cost_usd": round(float(cost_usd), 6),
            "units": units,
        }
        async with _lock:
            STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
            with STORE_PATH.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry) + "\n")
    except Exception:  # noqa: BLE001
        logger.warning("could not record %s spend for %s", model, source, exc_info=True)


async def record(
    model: str, tokens_in: int, tokens_out: int, *, source: str
) -> None:
    """Note one billed call. Never raises."""
    if tokens_in <= 0 and tokens_out <= 0:
        return
    try:
        cost = await cost_for(model, tokens_in, tokens_out)
        entry = {
            "at": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "model": model,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            # An unpriced model still gets a row. The token counts are
            # true either way, and a call recorded at zero dollars is a
            # better record than no call at all -- the pricing table
            # gets refreshed daily and may know the model tomorrow.
            "cost_usd": float(cost.get("cost_usd") or 0) if cost else 0.0,
        }
        async with _lock:
            STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
            # Append rather than temp-and-rename: this file is only ever
            # added to, and one short line written with O_APPEND does
            # not interleave with another.
            with STORE_PATH.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry) + "\n")
    except Exception:  # noqa: BLE001
        logger.warning("could not record gemini spend for %s", source, exc_info=True)


async def since(cutoff: datetime) -> list[dict[str, Any]]:
    """Entries newer than ``cutoff``. Never raises; worst case, empty."""
    try:
        async with _lock:
            if not STORE_PATH.exists():
                return []
            lines = STORE_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        logger.warning("could not read the gemini spend ledger", exc_info=True)
        return []

    keep_after = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    out: list[dict[str, Any]] = []
    live: list[str] = []
    stale = 0
    for line in lines:
        try:
            entry = json.loads(line)
            at = datetime.fromisoformat(str(entry["at"]))
        except (ValueError, KeyError, TypeError):
            stale += 1
            continue
        if at < keep_after:
            stale += 1
            continue
        live.append(line)
        if at >= cutoff:
            out.append(entry)

    if stale and len(lines) > TRIM_THRESHOLD:
        # Compact on the way past. Temp-and-rename here, unlike the
        # append: this one replaces the file, and a crash mid-write
        # would otherwise lose the history rather than a line of it.
        try:
            async with _lock:
                tmp = STORE_PATH.with_suffix(".tmp")
                tmp.write_text("\n".join(live) + "\n", encoding="utf-8")
                tmp.replace(STORE_PATH)
        except OSError:
            logger.warning("could not trim the gemini spend ledger", exc_info=True)
    return out
