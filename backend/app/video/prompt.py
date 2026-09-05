"""Turning a described scene into a prompt that looks like security footage.

The hard part is not describing the scene. It is stopping the model
making a film of it. Video models are trained on cinema, so left alone
they give you a dolly move, a shallow depth of field, warm grading and a
cut — every one of which tells a viewer instantly that this is not from
a camera bolted to a ceiling.

So a request here is mostly a set of constraints, and the scene is the
small part the operator actually types. The constraints fall into three
groups:

* **Where the camera is.** Mount type and height do more for
  authenticity than anything else. A ceiling dome looking down at 45
  degrees reads as surveillance before a single pixel of content does.
* **What the camera is.** Fixed focus, wide angle, no bokeh, fixed
  exposure that blows out a window, mild sensor noise in the shadows.
  Cameras that cost two hundred dollars look like it.
* **What it must not do.** Enumerated explicitly, because the model's
  defaults are all cinematic and silence is taken as consent.

Nothing here is a Veo-specific trick; it is a description of what real
security footage looks like, which is the only durable way to ask.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---- The vocabulary an operator picks from -------------------------------

# Mount is the strongest single lever on whether footage reads as real,
# so these are described by what the resulting frame looks like rather
# than by product category.
VANTAGES: dict[str, str] = {
    "ceiling_dome": (
        "mounted on the ceiling roughly 3 metres up, looking down at about "
        "45 degrees, the way a dome camera sits over a room"
    ),
    "high_corner": (
        "mounted high in the corner where two walls meet, about 3 metres up, "
        "covering the room diagonally"
    ),
    "above_door": (
        "mounted directly above a doorway looking outward across the "
        "threshold, so people approach the lens"
    ),
    "doorway_eye_level": (
        "mounted beside a door at head height, the way an intercom or "
        "video doorbell sits, so faces fill much of the frame"
    ),
    "pole_exterior": (
        "mounted on a pole about 5 metres up looking down across open "
        "ground, the way a car park camera sits"
    ),
    "under_eave": (
        "mounted under the eave of a building looking down along the wall "
        "and the ground in front of it"
    ),
    "shelf_height": (
        "mounted at shelf height looking along an aisle, the way a small "
        "camera tucked on a bracket sits"
    ),
}

SETTINGS: dict[str, str] = {
    "retail_checkout": "the checkout counter of a clothing shop, a till and a card terminal on the counter",
    "retail_floor": "the shop floor of a clothing store, racks and folded stock on tables",
    "warehouse_aisle": "an aisle between tall racking in a warehouse, pallets and boxes",
    "loading_dock": "a loading dock with a roller door and a parked pallet truck",
    "office_lobby": "an office reception lobby with a desk, glass doors and a seating area",
    "corridor": "an internal corridor with doors along it",
    "parking_lot": "an outdoor car park with marked bays and parked cars",
    "front_entrance": "the front entrance of a building, glass doors and a mat",
    "stockroom": "a back-of-house stockroom with shelving and stacked cartons",
}

# The lighting a camera is actually in, including the two failure modes
# that give real footage away: blown windows in daylight, and the flat
# grey of an IR illuminator at night.
LIGHTING: dict[str, str] = {
    "daylight_indoor": (
        "daytime, lit by overhead fluorescent panels with daylight coming "
        "through a window that is blown out to white because the camera "
        "exposes for the room"
    ),
    "daylight_outdoor": "flat overcast daylight, no strong shadows",
    "harsh_sun": "bright direct sun, hard shadows, highlights clipped to white",
    "evening_lit": "after dark indoors, lit only by the building's own lights, dim corners",
    "night_ir": (
        "night, infrared illumination, so the image is monochrome greyscale "
        "with a bright hotspot near the camera falling off to darkness, and "
        "eyes and retroreflective surfaces glowing white"
    ),
    "sodium_lot": "night in a car park under orange sodium lights, heavy noise in the dark areas",
}

ACTIVITY: dict[str, str] = {
    "empty": "nobody in frame; the space is still apart from small ambient movement",
    "one_person": "a single person in frame",
    "few_people": "two or three people in frame, going about unrelated business",
    "busy": "six or more people moving through the frame at once",
}

# Always applied. This is the camera itself, and it does not vary with
# the scene — a wide fixed lens with deep focus and no operator behind it.
CAMERA_CHARACTER = (
    "Shot on a fixed commercial security camera: a wide-angle lens with "
    "mild barrel distortion at the edges, deep focus so everything from "
    "the foreground to the back wall is equally sharp, and no shallow "
    "depth of field or background blur anywhere. Fixed automatic exposure "
    "that cannot hold both the bright and dark parts of the scene. Visible "
    "sensor noise in the shadows. Slightly soft, slightly over-sharpened, "
    "flat and uncorrected colour with no film grading. The camera is "
    "bolted in place and never moves: no pan, no tilt, no zoom, no dolly, "
    "no handheld drift, no rack focus. One continuous unbroken shot from "
    "one angle with no cuts."
)

# Enumerated because the model's defaults are all cinematic. Timestamps
# are excluded deliberately: generated on-screen text comes out garbled,
# and vFusion composites its own overlay downstream where it can be
# correct and match the Helix event.
FORBIDDEN = (
    "Not cinematic. No camera movement of any kind. No cuts, no scene "
    "changes, no montage. No shallow depth of field, no bokeh, no lens "
    "flare, no colour grading, no film look, no slow motion. No music or "
    "score. No on-screen text, no timestamp, no camera name, no watermark, "
    "no user interface overlay. Nobody looks at or acknowledges the camera. "
    "No dramatic staging or acting — ordinary people doing an ordinary "
    "thing, unaware they are recorded."
)


@dataclass
class VideoRequest:
    """What to make. Everything except ``scene`` shapes the camera."""

    # The one free-text part: what is happening.
    scene: str
    setting: str = "retail_checkout"
    vantage: str = "ceiling_dome"
    lighting: str = "daylight_indoor"
    activity: str = "one_person"
    # "general" covers the room; "focused" points at one thing, which is
    # what you want when a Helix event has to be visible in frame.
    framing: str = "general"
    focus_target: str = ""
    duration_seconds: int = 8
    resolution: str = "720p"
    aspect_ratio: str = "16:9"
    model: str = "veo-3.1-generate-preview"
    # Appended verbatim. An escape hatch for the thing no dropdown
    # anticipated, which on a first version is most things.
    extra: str = ""
    # Ambient sound only. The virtual camera's audio path is always on,
    # so silence would be conspicuous — but a score would be worse.
    want_audio: bool = True
    notes: dict[str, Any] = field(default_factory=dict)


def describe(req: VideoRequest) -> str:
    """The prompt. Order matters: subject, then camera, then prohibitions.

    Scene first because it is what the model anchors on, camera second so
    the constraints modify a scene it has already committed to, and the
    forbidden list last where it is closest to generation.
    """
    setting = SETTINGS.get(req.setting, req.setting)
    vantage = VANTAGES.get(req.vantage, req.vantage)
    lighting = LIGHTING.get(req.lighting, req.lighting)
    activity = ACTIVITY.get(req.activity, req.activity)

    if req.framing == "focused" and req.focus_target.strip():
        aim = (
            f"The camera is deliberately aimed at {req.focus_target.strip()}, "
            "which sits clearly in the middle of the frame and stays visible "
            "for the whole clip."
        )
    else:
        aim = (
            "The camera is positioned for general coverage of the area rather "
            "than aimed at any one thing, so the space matters more than any "
            "single subject."
        )

    audio = (
        "Ambient sound only — room tone, distant movement, the everyday noise "
        "of the place. No music, no narration."
        if req.want_audio
        else "No audio."
    )

    return "\n\n".join(
        [
            f"Security camera footage of {setting}. {req.scene.strip()}",
            f"In frame: {activity}.",
            f"The camera is {vantage}. {aim}",
            f"Lighting: {lighting}.",
            CAMERA_CHARACTER,
            audio,
            FORBIDDEN,
            req.extra.strip(),
        ]
    ).strip()
