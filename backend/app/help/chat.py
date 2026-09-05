"""The help assistant's prompt.

Its job is to be right about vFusion specifically, including the
unglamorous parts: what the product refuses to do, what is only
half-built, and where a thing lives. General LLM knowledge about
"automation platforms" is worse than useless here — it produces
plausible answers about features that do not exist, and the person
asking has no way to tell.
"""

from __future__ import annotations

import json as _json
import logging
from typing import Any


logger = logging.getLogger(__name__)

# Flash only, and deliberately. The corpus is large and the job is
# comprehension rather than generation, which flash does well — and with
# ~51k tokens going in, quietly falling back to Pro would cost roughly
# ten times as much for an answer nobody asked to upgrade. Two attempts,
# then an honest failure.
MODEL = "gemini-2.5-flash"
ATTEMPTS = 2

MAX_TURNS = 16


SYSTEM = """You are the help assistant built into vFusion. Someone using \
it has a question about the product.

Everything you need is in WHAT VFUSION IS below. It is assembled from \
vFusion's own source at runtime: its documentation, its live action and \
endpoint lists, and the docstrings its authors wrote — which is where \
the constraints live, so it is also the record of what does NOT work \
and why.

HOW TO ANSWER
- Answer only from that material. If it does not say, say you do not \
know and name where they could look. Do not fill a gap with what \
automation tools usually do — vFusion is specific, and a confident \
guess is indistinguishable from a fact to whoever is reading.
- Be direct about limits. "vFusion cannot do that" is a good answer \
when it is true, and much better than a workaround that does not exist.
- Say where a thing lives, in the words on screen: which page, which \
tab, which button. Someone asking how to do something wants to go and \
do it.
- Short. Two or three sentences for most questions. Expand when the \
answer genuinely needs steps.
- Plain language. The docstrings are written for engineers; the person \
asking may not be one.
- No invented endpoint names, action types, settings or page names. If \
it is not in the material below, it does not exist.

Respond with ONLY this JSON object:

{
  "reply": "your answer, plain text, no markdown headings",
  "where": null or "Page › Tab — where to go to do this"
}
"""


def build_prompt(messages: list[dict[str, str]], corpus: str) -> str:
    convo = messages[-MAX_TURNS:]
    lines = ["=== CONVERSATION ==="]
    for m in convo:
        who = "User" if m.get("role") == "user" else "You"
        lines.append(f"{who}: {m.get('content', '')}")
    lines.append("You:")
    return "\n\n".join(
        [SYSTEM, "=== WHAT VFUSION IS ===", corpus, "\n".join(lines)]
    )


def ask(api_key: str, prompt: str) -> tuple[dict[str, Any], str, int, int]:
    from google import genai

    client = genai.Client(api_key=api_key)
    last: Exception | None = None
    for _ in range(ATTEMPTS):
        model = MODEL
        try:
            res = client.models.generate_content(
                model=model,
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "max_output_tokens": 1536,
                },
            )
            text = (res.text or "").strip()
            if not text:
                raise RuntimeError("model returned an empty response")
            data = _json.loads(text)
            if not isinstance(data, dict) or not data.get("reply"):
                raise RuntimeError("model returned no reply")
            usage = getattr(res, "usage_metadata", None)
            return (
                {
                    "reply": str(data.get("reply") or ""),
                    "where": str(data["where"]).strip() if data.get("where") else None,
                },
                model,
                int(getattr(usage, "prompt_token_count", 0) or 0),
                int(getattr(usage, "candidates_token_count", 0) or 0),
            )
        except Exception as e:  # noqa: BLE001
            last = e
            continue
    raise RuntimeError(f"the help assistant could not answer: {last}")
