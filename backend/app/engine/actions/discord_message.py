"""Action: post a message to Discord through an incoming webhook.

The channel belongs to the webhook, created in Discord under Channel →
Edit Channel → Integrations → Webhooks, so a flow says what to send and
the connection says where it lands.

Unlike Slack, Discord fully honours the name and avatar overrides, so
one webhook can post as "Camera alerts" from one flow and "Door alerts"
from another. Its message limit is a hard 2,000 characters.

See ``app.connectors.chat`` for the transport, and for why a message is
text rather than an image.
"""

from __future__ import annotations

import logging
from typing import Any

from app.connectors import chat
from app.crypto import decrypt_secret
from app.engine.templates import resolve_deep
from app.models import Connection

logger = logging.getLogger(__name__)

SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "connection_id",
            "label": "Discord connection",
            "type": "connection_ref",
            "connection_type": "discord",
            "required": True,
        },
        {
            "name": "text",
            "label": "Message",
            "type": "text",
            "required": True,
            "default": "",
            "help": (
                "What to post. Insert values from the event or an earlier step with "
                "+ variable. Discord renders markdown: **bold**, *italic*, `code`, and "
                "```fenced blocks```. Links post as plain URLs. Anything past 2,000 "
                "characters is truncated, because Discord rejects the message otherwise."
            ),
        },
        {
            "name": "username",
            "label": "Post as",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Overrides the name on the message, so one webhook can carry several kinds of alert.",
        },
        {
            "name": "avatar_url",
            "label": "Avatar URL",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Image Discord fetches for the avatar. Must be reachable from the public internet, so a vFusion URL will not work.",
        },
    ]
}

SAMPLE_OUTPUT: dict[str, Any] = {
    "ok": True,
    "service": "discord",
    "status_code": 204,
    "text": "Deer on the Back Porch camera.",
    "truncated": False,
    "attempts": 1,
}


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    if connection.type != "discord":
        raise ValueError(f"discord_message needs a discord connection, got {connection.type!r}")
    secret = decrypt_secret(connection.encrypted_secret) or {}
    url = secret.get("webhook_url") or ""

    text = resolve_deep(config.get("text"), ctx)
    text = "" if text is None else str(text)
    username = resolve_deep(config.get("username"), ctx) or None
    avatar = resolve_deep(config.get("avatar_url"), ctx) or None

    progress = ctx.get("_progress")
    if progress:
        await progress.phase("discord_post", "running", "posting to Discord")
    try:
        result = await chat.send(
            service="discord",
            url=url,
            text=text,
            username=str(username) if username else None,
            avatar_url=str(avatar) if avatar else None,
        )
    except chat.ChatError as e:
        if progress:
            await progress.phase("discord_post", "failed", str(e))
        raise ValueError(str(e)) from e
    if progress:
        await progress.phase(
            "discord_post",
            "success",
            "message truncated to fit" if result["truncated"] else "delivered",
        )
    return result
