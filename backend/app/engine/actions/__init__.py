"""Action registry.

Each action type knows how to run itself given config + a template context
(``{trigger, steps}``) + a Connection. Adding a new action means writing
one module that registers via ``ACTIONS[type] = ActionSpec(...)`` and
exposes UI metadata via ``schema`` plus an ``output_sample`` so the
variable picker can render its result shape for downstream steps.

Order here drives the order of the action-type dropdown in the editor.
Easy-mode end-to-end actions first; the more granular building blocks
follow for power users.
"""

from typing import Any, Awaitable, Callable, NamedTuple

from app.engine.actions.gemini_analyze_camera import (
    SAMPLE_OUTPUT as GEMINI_ANALYZE_CAMERA_OUTPUT,
    SCHEMA as GEMINI_ANALYZE_CAMERA_SCHEMA,
    run as run_gemini_analyze_camera,
)
from app.engine.actions.gemini_analyze_still_image import (
    SAMPLE_OUTPUT as GEMINI_ANALYZE_STILL_OUTPUT,
    SCHEMA as GEMINI_ANALYZE_STILL_SCHEMA,
    run as run_gemini_analyze_still_image,
)
from app.engine.actions.verkada_api_call import (
    SAMPLE_OUTPUT as VERKADA_API_CALL_OUTPUT,
    SCHEMA as VERKADA_API_CALL_SCHEMA,
    run as run_verkada_api_call,
)
from app.engine.actions.verkada_helix_event import (
    SAMPLE_OUTPUT as VERKADA_HELIX_EVENT_OUTPUT,
    SCHEMA as VERKADA_HELIX_EVENT_SCHEMA,
    run as run_verkada_helix_event,
)
from app.engine.actions.verkada_unlock_door import (
    SAMPLE_OUTPUT as VERKADA_UNLOCK_DOOR_OUTPUT,
    SCHEMA as VERKADA_UNLOCK_DOOR_SCHEMA,
    run as run_verkada_unlock_door,
)


class ActionSpec(NamedTuple):
    type: str
    label: str
    description: str
    schema: dict[str, Any]
    output_sample: dict[str, Any]
    run: Callable[..., Awaitable[dict[str, Any]]]
    # Short slug used as the default step name when a node is added with this
    # action type. Keeps step names readable (e.g. "analyze" instead of "step")
    # and template-friendly: {{ steps.<default_step_name>.output.* }}.
    default_step_name: str = "step"


ACTIONS: dict[str, ActionSpec] = {
    # ---- Easy-mode pipeline actions (default order in the picker) ----
    "gemini_analyze_camera": ActionSpec(
        type="gemini_analyze_camera",
        label="Gemini: Analyze camera video (Verkada → Gemini)",
        description=(
            "Pull a short historical clip from the Verkada camera at the "
            "trigger time, send the MP4 to Gemini, return the AI text. "
            "Best for motion / object events where movement matters."
        ),
        schema=GEMINI_ANALYZE_CAMERA_SCHEMA,
        output_sample=GEMINI_ANALYZE_CAMERA_OUTPUT,
        run=run_gemini_analyze_camera,
        default_step_name="analyze",
    ),
    "gemini_analyze_still_image": ActionSpec(
        type="gemini_analyze_still_image",
        label="Gemini: Analyze camera still image (live frame)",
        description=(
            "Pull a single live frame from the Verkada camera right now "
            "and send the JPEG to Gemini. Faster than the video flavor "
            "and ~10× cheaper per request — pick this when one frame is "
            "enough (counts, presence, OCR, weather, etc.)."
        ),
        schema=GEMINI_ANALYZE_STILL_SCHEMA,
        output_sample=GEMINI_ANALYZE_STILL_OUTPUT,
        run=run_gemini_analyze_still_image,
        default_step_name="analyze",
    ),
    "verkada_helix_event": ActionSpec(
        type="verkada_helix_event",
        label="Verkada: Helix event (post AI / metadata)",
        description=(
            "POST a video-tagging event to Verkada Helix with arbitrary "
            "attributes. Pair with gemini_analyze_camera to log AI text."
        ),
        schema=VERKADA_HELIX_EVENT_SCHEMA,
        output_sample=VERKADA_HELIX_EVENT_OUTPUT,
        run=run_verkada_helix_event,
        default_step_name="post_helix",
    ),
    "verkada_unlock_door": ActionSpec(
        type="verkada_unlock_door",
        label="Verkada: Unlock door",
        description=(
            "Convenience preset for the door admin-unlock endpoint."
        ),
        schema=VERKADA_UNLOCK_DOOR_SCHEMA,
        output_sample=VERKADA_UNLOCK_DOOR_OUTPUT,
        run=run_verkada_unlock_door,
        default_step_name="unlock_door",
    ),
    # ---- Generic / building-block actions ----
    "verkada_api_call": ActionSpec(
        type="verkada_api_call",
        label="Verkada API call (any endpoint)",
        description=(
            "Call any endpoint from the API Catalog. Path/query/body values "
            "can reference trigger data or prior step outputs via "
            "{{ trigger.data.field }} or {{ steps.<name>.output.<path> }}."
        ),
        schema=VERKADA_API_CALL_SCHEMA,
        output_sample=VERKADA_API_CALL_OUTPUT,
        run=run_verkada_api_call,
        default_step_name="api_call",
    ),
}
