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


# What each open path is for, in the terms someone would actually ask
# about it. The earlier version led with "Authenticated by: None", which
# reads like an alarm on a health check that returns the word "ok", and
# buried whether there was anything to do about it.
#
# ``required`` is the useful distinction: most of these cannot be closed
# without breaking something that has no way to sign in. The ones that
# can be closed say so.
SURFACE_NOTES: dict[str, dict[str, object]] = {
    "/hooks": {
        "label": "Webhook ingress",
        "plain": (
            "Where Verkada POSTs events. Every request carries a signature "
            "that is checked before anything is read or stored."
        ),
        "who": "Verkada Command",
        "required": True,
        "note": None,
    },
    "/api/auth": {
        "label": "Sign in",
        "plain": (
            "Login, logout, and the status check the page uses to decide "
            "whether to show you a login form."
        ),
        "who": "Your browser, before you are signed in",
        "required": True,
        "note": (
            "Rate limited: five free attempts, then a doubling cooldown."
        ),
    },
    "/api/config": {
        "label": "Login-screen config",
        "plain": (
            "Branding and the public webhook URL, read by the login page "
            "before you sign in. No credentials in it."
        ),
        "who": "Your browser, before you are signed in",
        "required": True,
        "note": (
            "It does reveal your tunnel hostname and whether a Verkada org "
            "is connected, to anyone who can reach this host."
        ),
    },
    "/api/health": {
        "label": "Health check",
        "plain": (
            "Answers {\"status\": \"ok\"} and nothing else. Docker restarts "
            "the container when it stops answering."
        ),
        "who": "Docker",
        "required": True,
        "note": None,
    },
    "/onvif": {
        "label": "ONVIF camera service",
        "plain": (
            "How Verkada's Command Connector talks to the virtual camera. "
            "This one is authenticated -- the Connector proves itself with "
            "a digest inside every request -- it just cannot use a browser "
            "cookie to do it."
        ),
        "who": "Command Connector",
        "required": True,
        "note": (
            "One call, GetSystemDateAndTime, answers unauthenticated by "
            "design: a client needs your clock before it can compute the "
            "digest. It returns the time and nothing else."
        ),
    },
    "/docs": {
        "label": "Interactive API docs",
        "plain": (
            "A browsable page listing every endpoint. Nobody added it -- it "
            "comes with the web framework and is on by default."
        ),
        "who": "Nothing. It exists for humans.",
        "required": False,
        "note": (
            "vFusion runs fine without it. It exposes no data, but it hands "
            "anyone who can reach this host a map of the API."
        ),
    },
    "/redoc": {
        "label": "API reference",
        "plain": "The same listing as /docs, rendered as read-only docs.",
        "who": "Nothing. It exists for humans.",
        "required": False,
        "note": None,
    },
    "/openapi.json": {
        "label": "API schema",
        "plain": (
            "The machine-readable file the two pages above are built from."
        ),
        "who": "/docs and /redoc",
        "required": False,
        "note": None,
    },
}
