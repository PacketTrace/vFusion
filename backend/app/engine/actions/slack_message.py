"""Action: post a message to Slack through an incoming webhook.

The channel is decided when the webhook is created in Slack, not here,
so a flow says what to send and the connection says where it lands.
Point two connections at two webhooks to send to two channels.

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
            "label": "Slack connection",
            "type": "connection_ref",
            "connection_type": "slack",
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
                "+ variable. Slack renders its own flavour of markdown: *bold*, _italic_, "
                "`code`, and <https://example.com|a link>. Longer than 3,000 characters is "
                "truncated rather than rejected."
            ),
        },
        {
            "name": "username",
            "label": "Post as",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": (
                "Overrides the name the message appears under. Honoured for webhooks made "
                "through a legacy custom integration; newer Slack apps ignore it and use "
                "the app's own name."
            ),
        },
        {
            "name": "icon_url",
            "label": "Icon URL",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Image Slack fetches for the avatar. Must be reachable from the public internet, so a vFusion URL will not work.",
        },
    ]
}

SAMPLE_OUTPUT: dict[str, Any] = {
    "ok": True,
    "service": "slack",
    "status_code": 200,
    "text": "Deer on the Back Porch camera.",
    "truncated": False,
    "attempts": 1,
}


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    if connection.type != "slack":
        raise ValueError(f"slack_message needs a slack connection, got {connection.type!r}")
    secret = decrypt_secret(connection.encrypted_secret) or {}
    url = secret.get("webhook_url") or ""

    text = resolve_deep(config.get("text"), ctx)
    text = "" if text is None else str(text)
    username = resolve_deep(config.get("username"), ctx) or None
    icon = resolve_deep(config.get("icon_url"), ctx) or None

    progress = ctx.get("_progress")
    if progress:
        await progress.phase("slack_post", "running", "posting to Slack")
    try:
        result = await chat.send(
            service="slack",
            url=url,
            text=text,
            username=str(username) if username else None,
            avatar_url=str(icon) if icon else None,
        )
    except chat.ChatError as e:
        if progress:
            await progress.phase("slack_post", "failed", str(e))
        raise ValueError(str(e)) from e
    if progress:
        await progress.phase(
            "slack_post",
            "success",
            "message truncated to fit" if result["truncated"] else "delivered",
        )
    return result
