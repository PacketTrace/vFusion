"""An advisor that sits beside the flow builder.

Not a second way to build. The builder generates flows; this answers the
questions you have while using it -- what a node does, whether vFusion
can do the thing you had in mind, why the draft came out the way it did,
whether you already have a flow like this.

The split matters. A chat that silently edits the canvas means flows
appear without anyone asking for one, and the operator stops being able
to predict what a message will do. So this returns prose, plus at most a
*suggestion*: a description the operator can send to the builder by
pressing a button. Generation stays one deliberate action.

It reasons from the same grounding the builder generates from -- the
live action registry, this org's real devices, the trigger taxonomy --
so the two can't tell you different things about the same install.
"""

from __future__ import annotations

import json as _json
import logging
from typing import Any


logger = logging.getLogger(__name__)

# Flash first, unlike the builder. Producing valid flow JSON against a
# schema is the harder job and gets the stronger model; answering "can
# this email me?" does not, and this is the surface people will use most
# casually. Pro is there when flash refuses or returns nothing usable.
MODEL_CHAIN = ("gemini-2.5-flash", "gemini-2.5-pro")

MAX_TURNS = 20


SYSTEM = """You are the assistant built into vFusion's flow builder. You \
help an operator think through an automation before, during and after \
they generate it. You are not the generator.

WHAT VFUSION IS
A self-hosted tool that reacts to Verkada webhooks (and schedules), runs \
a small sequence of steps, and writes the result back to Verkada Helix so \
it lands on the camera's timeline.

WHAT IT DOES NOT DO -- say so plainly when asked, because it is the most \
common wrong expectation:
- It does not send emails, texts or phone notifications. It writes a \
Helix event; the alert on that event is configured in Verkada Command.
- It cannot invent action types. The catalog below is all there is.
- It cannot act on data Verkada does not send.

HOW TO ANSWER
- Answer the question asked, in plain language. Short is good.
- Never output flow JSON. The builder does that, and a flow the operator \
did not ask for is worse than no answer.
- Ground every specific in the context below. If they name a camera, use \
the real one from THIS ORG'S DEVICES. If no camera matches, say so rather \
than guessing.
- When they describe something buildable, put a description they could \
paste into the builder in "suggestion" -- one short paragraph, concrete \
about trigger and steps. Do not put a suggestion on a question that was \
not a request to build something.
- If they already have a flow that does this, say which one instead.
- If what they want is not possible, say what is possible instead, or \
say nothing is. Do not invent a way.

Respond with ONLY this JSON object:

{
  "reply": "your answer, plain text, no markdown headings",
  "suggestion": null or "a description to send to the builder"
}
"""


def build_prompt(
    *,
    messages: list[dict[str, str]],
    context_blocks: list[str],
    current_flow: dict[str, Any] | None,
) -> str:
    """System rules, then grounding, then the conversation."""
    parts = [SYSTEM, *context_blocks]

    if current_flow:
        # What is on the canvas right now, so "why is there a condition
        # here" is answerable rather than guessed at.
        parts.append(
            "=== THE FLOW CURRENTLY OPEN IN THE BUILDER ===\n"
            + _json.dumps(current_flow, indent=1, default=str)[:12000]
        )
    else:
        parts.append(
            "=== THE FLOW CURRENTLY OPEN IN THE BUILDER ===\n"
            "Nothing yet — they have not generated or opened one."
        )

    # Trimmed to the most recent turns. A long thread is mostly the
    # operator working towards one question, and the early turns stop
    # earning their tokens.
    convo = messages[-MAX_TURNS:]
    lines = ["=== CONVERSATION ==="]
    for m in convo:
        who = "Operator" if m.get("role") == "user" else "You"
        lines.append(f"{who}: {m.get('content', '')}")
    lines.append("You:")
    parts.append("\n".join(lines))
    return "\n\n".join(parts)


def ask(api_key: str, prompt: str) -> tuple[dict[str, Any], str, int, int]:
    """(parsed, model that answered, prompt tokens, response tokens)."""
    from google import genai

    client = genai.Client(api_key=api_key)
    last: Exception | None = None
    for model in MODEL_CHAIN:
        try:
            res = client.models.generate_content(
                model=model,
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                    "max_output_tokens": 2048,
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
                    # Normalised here so an empty string from the model
                    # doesn't render as a button that suggests nothing.
                    "suggestion": (
                        str(data["suggestion"]).strip()
                        if data.get("suggestion")
                        else None
                    ),
                },
                model,
                int(getattr(usage, "prompt_token_count", 0) or 0),
                int(getattr(usage, "candidates_token_count", 0) or 0),
            )
        except Exception as e:  # noqa: BLE001 — try the next model
            last = e
            continue
    raise RuntimeError(f"the assistant could not answer: {last}")
