"""Posting a message to Slack or Discord through an incoming webhook.

Both services work the same way: the URL *is* the credential, you POST
JSON to it, and there is no other auth. That shared shape is why one
module serves both -- what differs is the field the text goes in, what
success looks like on the wire, and how long a message may be.

Three things here are the difference between a notification that
arrives and one that silently does not:

* **Length.** Discord rejects a message body over 2,000 characters
  outright, and an AI summary goes past that without trying. Truncating
  here turns a 400 into a slightly shorter alert.
* **Rate limits.** Discord allows a burst of about five per webhook and
  then answers 429 with the seconds to wait. A flow on a busy trigger
  hits that, so one retry is honoured rather than dropping the message.
* **Redaction.** The URL contains the token. It must never reach an
  exception, a log line, or a run record -- all three are read by
  people, and run records are shown in the UI.

Neither service can attach an image through an incoming webhook: they
take a URL and fetch it themselves, and vFusion's frames sit behind a
session cookie on a host that is not meant to be public. So the message
is text, and the honest place to say so is the field help.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

TIMEOUT_SEC = 15.0
# Discord's documented hard cap. Slack's `text` tolerates far more, but
# a wall of text in a channel helps nobody; 3,000 matches the limit of
# a Slack block, which is where a long message ends up anyway.
LIMITS = {"discord": 2000, "slack": 3000}
# Wait this long at most for a rate limit before giving up. Longer than
# a flow step should sit blocking a worker.
MAX_RETRY_WAIT_SEC = 10.0

ALLOWED_HOSTS = {
    "slack": ("hooks.slack.com",),
    "discord": ("discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"),
}

SERVICE_LABEL = {"slack": "Slack", "discord": "Discord"}


class ChatError(Exception):
    """Something went wrong that the operator can act on. The message is
    shown in the run record, so it never contains the webhook URL."""


def validate_url(service: str, url: str) -> str:
    """The URL, or a ChatError naming what is wrong with it.

    Checked rather than trusted for two reasons. The everyday one is a
    paste error -- a Discord URL in the Slack connection fails at 3am
    instead of now. The other is that this is the one place vFusion
    POSTs to an address the operator types, so restricting it to the
    service's own hosts keeps a notification connection from becoming a
    way to make the server talk to anything on its network.
    """
    cleaned = (url or "").strip()
    if not cleaned:
        raise ChatError(f"No {SERVICE_LABEL.get(service, service)} webhook URL is set on this connection.")
    parsed = urlparse(cleaned)
    if parsed.scheme != "https":
        raise ChatError("The webhook URL must start with https://")
    host = (parsed.hostname or "").lower()
    allowed = ALLOWED_HOSTS.get(service, ())
    if host not in allowed:
        raise ChatError(
            f"That does not look like a {SERVICE_LABEL.get(service, service)} webhook URL — "
            f"it should be on {allowed[0]}, not {host or 'an empty host'}."
        )
    if service == "discord" and "/api/webhooks/" not in parsed.path:
        raise ChatError("A Discord webhook URL contains /api/webhooks/. Copy it from Channel → Edit → Integrations → Webhooks.")
    if service == "slack" and not parsed.path.startswith("/services/"):
        raise ChatError("A Slack webhook URL contains /services/. Copy it from the Incoming Webhooks page of your Slack app.")
    return cleaned


def _redact(text: str, url: str) -> str:
    """Belt and braces: strip the URL if a library ever puts it in an
    error string we pass along."""
    out = (text or "").replace(url, "<webhook url>")
    return re.sub(r"https://\S*(hooks\.slack\.com|discord(app)?\.com)\S*", "<webhook url>", out)


def truncate(service: str, text: str) -> tuple[str, bool]:
    limit = LIMITS.get(service, 2000)
    if len(text) <= limit:
        return text, False
    # Leave room for the marker, and say it was cut rather than ending
    # mid-word with no explanation.
    return text[: limit - 2] + " …", True


def _payload(service: str, text: str, username: str | None, avatar_url: str | None) -> dict[str, Any]:
    if service == "discord":
        body: dict[str, Any] = {"content": text}
        if username:
            body["username"] = username[:80]
        if avatar_url:
            body["avatar_url"] = avatar_url
        return body
    body = {"text": text}
    if username:
        body["username"] = username
    if avatar_url:
        body["icon_url"] = avatar_url
    return body


def _explain(service: str, status: int, body: str) -> str:
    """A failure someone can do something about."""
    label = SERVICE_LABEL.get(service, service)
    lowered = (body or "").lower()
    if status in (401, 403, 404) or "no_service" in lowered or "invalid_token" in lowered:
        return (
            f"{label} rejected the webhook as unknown ({status}). It was probably deleted or "
            "regenerated on their side — make a new one and paste it into the connection."
        )
    if status == 400 and "invalid_payload" in lowered:
        return f"{label} rejected the message body. Usually an empty message, or one with unbalanced formatting."
    if status == 413 or "too long" in lowered or "or fewer in length" in lowered:
        return f"{label} rejected the message as too long, even after truncation."
    if status == 429:
        return f"{label} is rate limiting this webhook and did not accept the message."
    return f"{label} returned {status}: {(body or '')[:200] or 'no detail'}"


async def send(
    *,
    service: str,
    url: str,
    text: str,
    username: str | None = None,
    avatar_url: str | None = None,
) -> dict[str, Any]:
    """Post one message. Returns a summary; raises ChatError on failure."""
    if service not in ALLOWED_HOSTS:
        raise ChatError(f"unknown chat service {service!r}")
    target = validate_url(service, url)

    message = (text or "").strip()
    if not message:
        # Both services reject an empty body, and the usual reason it is
        # empty is that every template ref in it resolved to nothing.
        raise ChatError(
            "The message came out empty. If it is built from {{ }} references, "
            "check that the step above actually produced them."
        )
    message, was_truncated = truncate(service, message)
    body = _payload(service, message, username, avatar_url)

    attempts = 0
    async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as client:
        while True:
            attempts += 1
            try:
                res = await client.post(target, json=body)
            except httpx.HTTPError as e:
                raise ChatError(
                    f"Could not reach {SERVICE_LABEL[service]}: {_redact(str(e), target)}"
                ) from e

            if res.status_code == 429 and attempts == 1:
                wait = _retry_after(res)
                if wait is not None and wait <= MAX_RETRY_WAIT_SEC:
                    logger.info("%s rate limited, retrying in %.1fs", service, wait)
                    await asyncio.sleep(wait)
                    continue

            if 200 <= res.status_code < 300:
                return {
                    "ok": True,
                    "service": service,
                    "status_code": res.status_code,
                    "text": message,
                    "truncated": was_truncated,
                    "attempts": attempts,
                }
            raise ChatError(_explain(service, res.status_code, _redact(res.text, target)))


def _retry_after(res: httpx.Response) -> float | None:
    """Seconds to wait, from whichever form the service used."""
    try:
        data = res.json()
        if isinstance(data, dict) and data.get("retry_after") is not None:
            return max(0.0, float(data["retry_after"]))
    except (ValueError, TypeError):
        pass
    header = res.headers.get("retry-after")
    if header:
        try:
            return max(0.0, float(header))
        except ValueError:
            return None
    return None
