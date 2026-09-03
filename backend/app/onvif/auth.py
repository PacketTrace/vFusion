"""WS-UsernameToken, the authentication ONVIF clients actually send.

The token carries a username, a random nonce, a timestamp, and

    PasswordDigest = Base64( SHA1( nonce + created + password ) )

with the nonce as raw bytes rather than its Base64 text -- getting that
wrong produces a digest that is stable, plausible and never matches.

Two things about this scheme are worth knowing before debugging it.

**The clock matters.** A client asks for ``GetSystemDateAndTime`` first,
without authentication, precisely so it can compute the offset between
its clock and the device's and stamp ``Created`` in the device's frame of
reference. A device that demands authentication on that call breaks
every subsequent one, and the error the client reports is "authentication
failed" rather than "you would not tell me the time".

**Some clients send the password in the clear** as PasswordText instead.
It is accepted here: the alternative is refusing a client that is doing
something the specification permits, over a stream whose credentials are
already travelling as plain RTSP on a LAN.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any
from xml.etree import ElementTree as ET


WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"

DIGEST_TYPE = (
    "http://docs.oasis-open.org/wss/2004/01/"
    "oasis-200401-wss-username-token-profile-1.0#PasswordDigest"
)


def _text(node: ET.Element | None) -> str:
    return (node.text or "").strip() if node is not None else ""


def extract(root: ET.Element) -> dict[str, str] | None:
    """Pull the UsernameToken out of a parsed envelope, if there is one."""
    token = root.find(f".//{{{WSSE}}}UsernameToken")
    if token is None:
        return None
    password = token.find(f"{{{WSSE}}}Password")
    return {
        "username": _text(token.find(f"{{{WSSE}}}Username")),
        "password": _text(password),
        "type": (password.get("Type") or "") if password is not None else "",
        "nonce": _text(token.find(f"{{{WSSE}}}Nonce")),
        "created": _text(token.find(f"{{{WSU}}}Created")),
    }


def verify(token: dict[str, Any] | None, username: str, password: str) -> bool:
    """Whether this token proves knowledge of the password."""
    if not token or not username or not password:
        return False
    if not hmac.compare_digest(token.get("username", ""), username):
        return False

    supplied = token.get("password", "")
    if not supplied:
        return False

    # Plain text, either declared as PasswordText or sent with no type.
    if "PasswordDigest" not in (token.get("type") or ""):
        return hmac.compare_digest(supplied, password)

    try:
        nonce = base64.b64decode(token.get("nonce", ""), validate=False)
    except Exception:
        return False
    created = token.get("created", "")
    digest = base64.b64encode(
        hashlib.sha1(nonce + created.encode("utf-8") + password.encode("utf-8")).digest()
    ).decode("ascii")
    return hmac.compare_digest(digest, supplied)
