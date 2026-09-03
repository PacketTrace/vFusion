"""What a broker has to do before a Verkada camera will publish to it.

Reverse-engineered from packet captures and confirmed against Verkada's
own setup guide. None of it is discoverable from the API: a camera
accepts a configuration it cannot use, reports nothing, and leaves the
evidence in a log on the broker side.

Each entry pairs the requirement with the symptom you get without it,
because the symptom is what someone actually has in front of them when
they come looking. "The CA needs basicConstraints=CA:TRUE" is useless
advice until you know that its absence reads as ``bad certificate``.

Kept here rather than in the frontend so the same list can back an
endpoint, and so the reasoning stays next to the code that acts on it.
"""

from __future__ import annotations

from typing import Any


# Verkada rejects every other port outright.
ALLOWED_PORTS = (443, 123, 53)

TOPIC = "/occupancy_trend/tracks"


REQUIREMENTS: list[dict[str, str]] = [
    {
        "id": "wss",
        "title": "Accept MQTT over WebSocket Secure",
        "detail": (
            "The camera speaks MQTT inside a WSS connection, not raw MQTT over "
            "TLS. Your broker needs a websockets listener, and anything "
            "terminating TLS in front of it must forward the Upgrade header."
        ),
        "symptom": "Broker logs 'First packet not CONNECT' and drops the client.",
    },
    {
        "id": "pq_tls",
        "title": "Terminate post-quantum TLS 1.3",
        "detail": (
            "The camera opens with a TLS 1.3-only ClientHello using key_share "
            "X25519MLKEM768 and ML-DSA signature algorithms. The terminator "
            "needs OpenSSL 3.5 or newer. Terminating in mosquitto directly is "
            "unreliable even when the version is high enough — nginx in front "
            "is the arrangement that works."
        ),
        "symptom": "'unexpected eof while reading' partway through the handshake.",
    },
    {
        "id": "ca_not_leaf",
        "title": "Give the camera the CA, not the server certificate",
        "detail": (
            "The certificate configured on the camera is its only trust "
            "anchor, so it must be the CA that signed your broker's "
            "certificate. Sending the broker's own leaf looks reasonable and "
            "does not work."
        ),
        "symptom": "TLS alert 'unknown ca' from the camera.",
    },
    {
        "id": "ca_true",
        "title": "CA carries basicConstraints=CA:TRUE",
        "detail": (
            "LibreSSL's 'req -x509' omits it by default, which is what macOS "
            "ships — a CA generated there looks fine and is rejected."
        ),
        "symptom": "TLS alert 'bad certificate'.",
    },
    {
        "id": "server_auth",
        "title": "Server certificate has extendedKeyUsage=serverAuth",
        "detail": "The camera checks the extension rather than assuming it.",
        "symptom": "Handshake fails with a certificate error and no detail.",
    },
    {
        "id": "san",
        "title": "Server certificate SAN contains the exact address",
        "detail": (
            "Whatever goes in broker_host_port — IP or hostname — must appear "
            "in the certificate's SAN. An address that routes correctly but "
            "is absent from the SAN fails, which is why moving the broker "
            "means reissuing and re-pushing every camera."
        ),
        "symptom": "TLS 'decrypt error' (alert 51) from the camera.",
    },
    {
        "id": "port",
        "title": "Listen on 443, 123 or 53",
        "detail": (
            "Verkada accepts no other port in broker_host_port. 443 is the "
            "sane choice; the other two are NTP and DNS."
        ),
        "symptom": "The API rejects the configuration outright.",
    },
    {
        "id": "credentials",
        "title": "Require a username and password",
        "detail": (
            "Both must be sent even though the API documents them as "
            "optional. Without them Verkada returns 200 and stores nothing."
        ),
        "symptom": "The push appears to succeed and reading it back shows an empty config.",
    },
    {
        "id": "analytics",
        "title": "Camera has people analytics and an Occupancy Trends line",
        "detail": (
            "Not a broker requirement, but the most common reason a correctly "
            "configured camera publishes nothing. The line is drawn in Command "
            "under Analytics — there is no API for it — and something has to "
            "physically cross it."
        ),
        "symptom": "Camera connects and authenticates, then sits silent forever.",
    },
    {
        "id": "topic",
        "title": f"Expect publishes on {TOPIC}",
        "detail": (
            "Roughly eight messages a second per tracked object, QoS 0, each "
            "carrying up to three independently typed objects. Around 5% are "
            "duplicate re-sends a few hundred milliseconds later."
        ),
        "symptom": "Subscribing to the wrong topic looks identical to no data.",
    },
    {
        "id": "reconnect",
        "title": "Expect a reconnect only on a config change",
        "detail": (
            "The camera reacts to the configuration changing, not to it being "
            "re-sent. Pushing identical settings may do nothing; clearing and "
            "then setting brings it back within 5-25 seconds. Keepalive is 60 "
            "seconds, and a gap over 90 logs a timeout."
        ),
        "symptom": "A re-push that changes nothing appears to have no effect.",
    },
]


def describe() -> dict[str, Any]:
    return {
        "topic": TOPIC,
        "allowed_ports": list(ALLOWED_PORTS),
        "requirements": REQUIREMENTS,
    }
