"""Action: event → pull the audio out of Verkada footage → Gemini → text.

The audio sibling of ``gemini_analyze_camera``. Same shape, same
connections, same model chain, same fallback rules — the difference is
that ffmpeg is asked for ``audio="only"``, so what reaches Gemini is a
64k mono .m4a rather than an MP4.

That distinction is the whole point. Gemini bills video at roughly 258
tokens per sampled frame and audio at about 32 tokens per second, so a
10-second span costs on the order of 2,500 tokens as video and 320 as
audio. Sending the MP4 and asking "what do you hear" would work and
would cost close to eight times as much for an answer that never looks
at a single pixel.

Everything downstream is unchanged: ``analyze_clip`` uploads whatever
path it is handed through the Files API, and ``verkada_helix_event``
takes whatever attributes the prompt produced.
"""

import asyncio
import logging
import time
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select

from app.connectors.verkada.footage import CLIP_ROOT, FootageError, grab_video_clip
from app.crypto import decrypt_secret
from app.db import SessionLocal
from app.engine.actions.gemini_analyze_camera import (
    GEMINI_MODELS,
    _coerce_float,
    _coerce_int,
)
from app.engine.actions.gemini_analyze_video import analyze_clip
from app.engine.templates import resolve_deep
from app.models import Connection
from app.pricing.gemini import cost_for


logger = logging.getLogger(__name__)


_DEFAULT_MODEL = "gemini-2.5-flash"
_DEFAULT_FALLBACK_CHAIN = "gemini-3.1-flash-lite"


# The one shipped audio analytic. Three fields, in the order an operator
# reads them: what kind of sound it was, the words if there were any, and
# a sentence of context tying the two together.
#
# Every value is capped at 200 characters because Helix truncates past
# that, and a transcript cut off mid-word in Command is worse than one
# the model summarized deliberately.
AUDIO_EXTRACTOR_PROMPT = (
    "Listen to this audio from a security camera and report what you "
    "hear. Respond with ONLY a JSON object - no prose, no code fence - "
    "with exactly three string keys:\n"
    "  \"sound\":       a short label for the dominant sound, lowercase, "
    "a few words at most (e.g. \"people talking\", \"dog barking\", "
    "\"vehicle engine\", \"door slamming\", \"glass breaking\", "
    "\"alarm\", \"wind\"). Use \"silence\" if there is nothing "
    "audible.\n"
    "  \"transcript\":  the speech, word for word, including who says "
    "what if more than one voice is distinguishable. Use \"none\" if "
    "nobody speaks, and \"unintelligible\" if there is clearly speech "
    "but you cannot make out the words. Do NOT invent words to fill a "
    "gap — an honest \"unintelligible\" is worth more than a plausible "
    "guess. HARD CAP 200 characters; if the speech runs longer, keep "
    "the most meaningful portion rather than trailing off.\n"
    "  \"description\": one to two sentences (HARD CAP 200 characters) "
    "on what was heard and what it suggests is happening — how many "
    "voices, their tone, whether it sounds routine or agitated, any "
    "background noise worth noting. Stay factual: describe the audio, "
    "do not speculate about what is on camera.\n\n"
    "Examples:\n"
    "  {\"sound\": \"people talking\", \"transcript\": \"Hey John, how "
    "are you doing?\", \"description\": \"Two people having a general "
    "conversation, relaxed and friendly. Footsteps and a door closing "
    "in the background.\"}\n"
    "  {\"sound\": \"dog barking\", \"transcript\": \"none\", "
    "\"description\": \"A single dog barking repeatedly close to the "
    "microphone, then trailing off. No voices.\"}\n"
    "  {\"sound\": \"vehicle engine\", \"transcript\": "
    "\"unintelligible\", \"description\": \"An engine idles then pulls "
    "away. Someone speaks briefly over it but the words are not "
    "clear.\"}\n"
    "  {\"sound\": \"silence\", \"transcript\": \"none\", "
    "\"description\": \"Nothing audible for the length of the clip "
    "apart from faint wind.\"}\n\n"
    "IMPORTANT: keep every value at or under 200 characters — Helix "
    "truncates anything longer."
)


AUDIO_PROMPT_TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "Audio extractor",
        "medium": "audio",
        "value": AUDIO_EXTRACTOR_PROMPT,
        "helix_event_type": {
            "event_type_uid": "tpl:audio-extractor",
            "name": "🔊 Audio Extractor",
            "event_schema": {
                "Sound": "string",
                "Transcript": "string",
                "Description": "string",
            },
        },
        "helix_attribute_mapping": {
            "Sound": "{{ output.json.sound }}",
            "Transcript": "{{ output.json.transcript }}",
            "Description": "{{ output.json.description }}",
        },
    },
]

_DEFAULT_PROMPT = AUDIO_EXTRACTOR_PROMPT


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "connection_id",
            "label": "Verkada connection",
            "type": "connection_ref",
            "connection_type": "verkada",
            "required": True,
        },
        {
            "name": "gemini_connection_id",
            "label": "Gemini connection",
            "type": "connection_ref",
            "connection_type": "gemini",
            "required": True,
        },
        {
            "name": "camera_id",
            "label": "Camera",
            "type": "camera_ref",
            "required": True,
            "help": "The camera's microphone must be enabled — a camera with audio off fails this step rather than returning an empty transcript.",
        },
        {
            "name": "start_epoch",
            "label": "Start time (unix seconds)",
            "type": "text",
            "required": True,
            "group": "advanced",
            "default_template": "{{ trigger.data.created }}",
            "help": "Auto-fills from {{ trigger.data.created }} when present.",
        },
        {
            "name": "model",
            "label": "Default model",
            "type": "select",
            "required": False,
            "options": GEMINI_MODELS,
            "default": _DEFAULT_MODEL,
            "docs_url": "https://ai.google.dev/gemini-api/docs/models",
            "help": "The first model tried for each request. If it returns 503/429/404, the fallback chain below is used.",
        },
        {
            "name": "prompt",
            "label": "Prompt",
            "type": "text",
            "required": False,
            "help": "Leave blank for the Audio extractor prompt (sound / transcript / description).",
            "templates": AUDIO_PROMPT_TEMPLATES,
        },
        {
            "name": "duration_sec",
            "label": "Clip duration (seconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Default 15. Audio is billed per second (~32 tokens/sec), so this is far cheaper to lengthen than a video clip — but a sentence usually lands inside 15s.",
        },
        {
            "name": "pre_roll_sec",
            "label": "Pre-roll (seconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Default 3. Audio starts this many seconds early so a sentence already underway when the event fired isn't clipped at the front.",
        },
        {
            "name": "pre_grab_delay_sec",
            "label": "Wait before grab (seconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Default 0. Unlike video there is no HD backfill to wait for, but a short wait lets more of an in-progress conversation land inside the window.",
        },
        {
            "name": "model_chain",
            "label": "Fallback model chain",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": f"Comma-separated models tried if the default model fails. Default: {_DEFAULT_FALLBACK_CHAIN}",
        },
        {
            "name": "active_timeout_sec",
            "label": "Upload-active timeout (seconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "How long to wait for Gemini's file state to become ACTIVE. Default 180.",
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "gemini_analyze_audio",
    "camera_id": "...",
    "text": "...",
    "json": {
        "sound": "people talking",
        "transcript": "Hey John, how are you doing?",
        "description": "Two people having a general conversation.",
    },
    "char_count": 120,
    "model_used": "gemini-2.5-flash",
    "audio_path": "/app/data/clips/abc.m4a",
    "duration_sec": 15,
    "file_size": 123456,
    "started_at_epoch": 1700000000,
}


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    """``connection`` is the Verkada connection (resolved via connection_id).
    The Gemini connection is looked up separately from ``gemini_connection_id``."""

    # ---- Verkada side ----
    secret = decrypt_secret(connection.encrypted_secret)
    api_key = secret.get("api_key")
    org_id = secret.get("org_id") or connection.external_id
    region = secret.get("region") or None
    if not api_key:
        raise ValueError("Verkada connection has no api_key set")
    if not org_id:
        raise ValueError("Verkada connection has no org_id")

    # ---- Gemini side ----
    gemini_conn_id_raw = config.get("gemini_connection_id")
    if not gemini_conn_id_raw:
        raise ValueError("gemini_connection_id is required")
    try:
        gemini_conn_id = UUID(str(gemini_conn_id_raw))
    except (ValueError, TypeError) as e:
        raise ValueError(
            f"gemini_connection_id must be a UUID: {gemini_conn_id_raw!r}"
        ) from e

    async with SessionLocal() as session:
        gemini_conn = (
            await session.execute(
                select(Connection).where(Connection.id == gemini_conn_id)
            )
        ).scalar_one_or_none()
    if gemini_conn is None or gemini_conn.type != "gemini":
        raise ValueError("Gemini connection not found")
    gemini_secret = decrypt_secret(gemini_conn.encrypted_secret)
    gemini_api_key = gemini_secret.get("api_key")
    if not gemini_api_key:
        raise ValueError("Gemini connection has no api_key set")

    # ---- Inputs (template-resolved) ----
    camera_id = resolve_deep(config.get("camera_id"), ctx)
    start_epoch_raw = resolve_deep(config.get("start_epoch"), ctx)
    duration_sec = max(
        1.0, _coerce_float(resolve_deep(config.get("duration_sec"), ctx), 15.0)
    )
    delay_sec = max(
        0.0, _coerce_float(resolve_deep(config.get("pre_grab_delay_sec"), ctx), 0.0)
    )
    pre_roll_sec = max(
        0.0, _coerce_float(resolve_deep(config.get("pre_roll_sec"), ctx), 3.0)
    )

    if not isinstance(camera_id, str) or not camera_id:
        raise ValueError("camera_id is required (string)")
    start_epoch = _coerce_int(start_epoch_raw, 0)
    if start_epoch <= 0:
        raise ValueError(
            f"start_epoch must be positive unix-seconds, got {start_epoch_raw!r}"
        )
    grab_start_epoch = max(0, start_epoch - int(pre_roll_sec))
    grab_duration = duration_sec + pre_roll_sec

    prompt = resolve_deep(config.get("prompt"), ctx) or _DEFAULT_PROMPT
    if not isinstance(prompt, str):
        prompt = str(prompt)

    default_model = resolve_deep(config.get("model"), ctx) or _DEFAULT_MODEL
    if not isinstance(default_model, str):
        default_model = str(default_model)
    chain_raw = resolve_deep(config.get("model_chain"), ctx) or _DEFAULT_FALLBACK_CHAIN
    if not isinstance(chain_raw, str):
        chain_raw = str(chain_raw)
    fallback = [m.strip() for m in chain_raw.split(",") if m.strip()]
    model_chain = [default_model] + [m for m in fallback if m != default_model]
    if not model_chain:
        raise ValueError("model chain is empty")

    active_timeout = _coerce_int(
        resolve_deep(config.get("active_timeout_sec"), ctx), 180
    )

    progress = ctx.get("_progress")

    # ---- Phase 1: optional wait ----
    wait_until = start_epoch + int(delay_sec)
    wait_remaining = wait_until - int(time.time())
    if wait_remaining > 0:
        if progress:
            await progress.phase(
                "wait_before_grab",
                "running",
                f"sleeping {wait_remaining}s so more of the audio lands in the window",
            )
        await asyncio.sleep(wait_remaining)
        if progress:
            await progress.phase("wait_before_grab", "success")

    # ---- Phase 2: ffmpeg audio extraction ----
    audio_path = CLIP_ROOT / f"{uuid4().hex}.m4a"
    if progress:
        await progress.phase(
            "ffmpeg_extract_audio",
            "running",
            f"extracting {grab_duration:.0f}s of audio from epoch "
            f"{grab_start_epoch} → {audio_path.name}",
        )
    grab_started = time.time()
    try:
        size = await grab_video_clip(
            api_key=api_key,
            org_id=org_id,
            camera_id=camera_id,
            start_epoch=grab_start_epoch,
            duration_sec=grab_duration,
            out_path=audio_path,
            progress=progress,
            base_url=region,
            audio="only",
        )
    except FootageError as e:
        if progress:
            await progress.phase("ffmpeg_extract_audio", "failed", str(e))
        raise ValueError(f"audio extraction failed: {e}") from e
    if progress:
        await progress.phase(
            "ffmpeg_extract_audio",
            "success",
            f"wrote {size / 1024:.0f} KB in {time.time() - grab_started:.1f}s",
        )

    # ---- Phase 3: Gemini analysis ----
    if progress:
        await progress.phase(
            "gemini_analyze",
            "running",
            f"uploading audio + running prompt against {model_chain[0]}",
        )
    analyze_started = time.time()
    try:
        result = await analyze_clip(
            gemini_api_key,
            audio_path,
            prompt,
            model_chain,
            active_timeout,
            progress=progress,
        )
    except Exception as e:  # noqa: BLE001
        if progress:
            await progress.phase("gemini_analyze", "failed", str(e))
        raise
    cost = await cost_for(
        result["model_used"], result["tokens_in"], result["tokens_out"]
    )
    if progress:
        cost_msg = f", ~${cost['cost_usd']:.4f}" if cost else ""
        await progress.phase(
            "gemini_analyze",
            "success",
            f"got {len(result['text'])} chars from {result['model_used']} "
            f"in {time.time() - analyze_started:.1f}s "
            f"({result['tokens_in']}/{result['tokens_out']} tok{cost_msg})",
        )

    out: dict[str, Any] = {
        "action": "gemini_analyze_audio",
        "camera_id": camera_id,
        "text": result["text"],
        "json": result.get("json"),
        "char_count": len(result["text"]),
        "model_used": result["model_used"],
        "audio_path": str(audio_path),
        "duration_sec": duration_sec,
        "file_size": size,
        "started_at_epoch": start_epoch,
        "tokens_in": result["tokens_in"],
        "tokens_out": result["tokens_out"],
    }
    if cost:
        out["cost"] = cost
    return out
