"""What answers without a session cookie.

The list lives here rather than in ``main.py`` so the security page can
render the real one instead of a hand-maintained copy of it. A copy
would be accurate on the day it was written and misleading forever
after -- which is the failure mode of every security checklist.
"""

from __future__ import annotations


# Routes that bypass the session-cookie gate. Order is irrelevant;
# ``main.py`` matches by prefix.
PUBLIC_PATH_PREFIXES: tuple[str, ...] = (
    "/hooks",
    "/api/auth",
    "/api/config",
    "/api/health",
    # ONVIF is not unauthenticated — it authenticates differently. A
    # camera client proves itself with a WS-UsernameToken digest inside
    # the SOAP envelope, checked per operation in app/api/onvif.py, and
    # has no way to obtain or present a session cookie. Leaving it behind
    # this gate means the Connector gets a 401 it cannot interpret before
    # any of that runs.
    "/onvif",
    # FastAPI's interactive docs.
    "/docs",
    "/redoc",
    "/openapi.json",
)


# How each public prefix is actually protected, and what it would mean
# if it were not. ``concern`` is None when the surface is fine as it is.
SURFACE_NOTES: dict[str, dict[str, str | None]] = {
    "/hooks": {
        "label": "Webhook ingress",
        "auth": "Verkada's signature over the request body",
        "why": "Verkada has no way to present a session cookie.",
        "concern": None,
    },
    "/api/auth": {
        "label": "Login, logout, password",
        "auth": "The password itself, rate limited",
        "why": "Has to answer before a session exists.",
        "concern": None,
    },
    "/api/config": {
        "label": "Public config",
        "auth": "None — returns branding and the public webhook URL",
        "why": "The login screen reads it before authenticating.",
        "concern": None,
    },
    "/api/health": {
        "label": "Health check",
        "auth": "None — returns {\"status\": \"ok\"}",
        "why": "Container orchestration probes it.",
        "concern": None,
    },
    "/onvif": {
        "label": "ONVIF camera service",
        "auth": "WS-UsernameToken digest, checked per operation",
        "why": "A Command Connector cannot hold a session cookie.",
        "concern": (
            "GetSystemDateAndTime answers unauthenticated by design — clients "
            "compute digest clock skew from it before they can authenticate. "
            "It returns the time and nothing else."
        ),
    },
    "/docs": {
        "label": "Interactive API docs",
        "auth": "None",
        "why": "Convenient in development.",
        "concern": (
            "Describes every endpoint to anyone who can reach this host. It "
            "exposes no data, but it is a map. Set ENABLE_DOCS=false in .env "
            "to turn it off."
        ),
    },
    "/redoc": {
        "label": "API reference",
        "auth": "None",
        "why": "Same document as /docs, rendered differently.",
        "concern": "Turned off by the same ENABLE_DOCS=false.",
    },
    "/openapi.json": {
        "label": "OpenAPI schema",
        "auth": "None",
        "why": "Backs /docs and /redoc.",
        "concern": "Turned off by the same ENABLE_DOCS=false.",
    },
}
