"""Group Verkada audit events the way Verkada's own Audit Log page does.

Command's page filters by category -- Admin, User Management, Device
Management, Cameras, Access Control, Sensors, Alarms, Intercoms,
Workplace, Gateway, Integrations, Others -- and an operator who has used
it expects the same words here. The names below come from the help
centre's "Understand all audit log events" reference; anything it does
not list is classified by keyword, and ``other`` is the honest fallback.

One deliberate departure: ``Public API Request`` gets its own ``api``
category rather than sitting in Integrations. In an org that runs any
integration it is the overwhelming majority of the log, and it is the
one class vFusion users most want to see -- or hide -- as a unit.
"""

from __future__ import annotations

CATEGORIES: dict[str, str] = {
    "api": "API requests",
    "users": "User management",
    "admin": "Admin",
    "support": "Verkada Support",
    "devices": "Device management",
    "cameras": "Cameras",
    "access": "Access control",
    "sensors": "Sensors",
    "alarms": "Alarms",
    "intercoms": "Intercoms",
    "workplace": "Workplace",
    "gateway": "Gateway",
    "integrations": "Integrations",
    "other": "Other",
}

# Explicit names first. Keyed lower-case; matched after stripping
# surrounding whitespace so a trailing space in Verkada's data (they
# exist) does not turn a known event into "other".
_BY_NAME: dict[str, str] = {
    "public api request": "api",
    # User logins
    "user attempted login": "users",
    "user attempted logout": "users",
    "user login": "users",
    "user logout": "users",
    # Verkada Support
    "support access": "support",
    "support access granted": "support",
    "device remotely accessed": "support",
    # User management
    "export users csv": "users",
    "user added to organization": "users",
    "user removed from organization": "users",
    "users removed from organization": "users",
    "organization user provisioned": "users",
    "resent invitation for user to join organization": "users",
    "user created": "users",
    "user invited": "users",
    "user email modified": "users",
    "user employment modified": "users",
    "user name modified": "users",
    "user changed password": "users",
    "user permissions modified": "users",
    "user roles modified": "users",
    "user modified rtsp credentials": "cameras",
    "user preference set": "users",
    "two-factor reset": "users",
    "saml config created": "admin",
    "saml config deleted": "admin",
    "saml idp initiated": "users",
    "saml config updated": "admin",
    "scim provider created": "admin",
    "scim provider deleted": "admin",
    "scim provider modified": "admin",
    "scim token regenerated": "admin",
    "user group action taken": "users",
    "force logout requested": "users",
    # Organization, site, group
    "organization modified": "admin",
    "organization property modified": "admin",
    "site action taken": "admin",
    "webhook toggled": "integrations",
    "api key modified": "integrations",
    # Device management
    "devices installed": "devices",
    "devices uninstalled": "devices",
    "license claim event": "admin",
    "license grant event": "admin",
    "override trial event": "admin",
    "viewing station grid updated": "devices",
    # Cameras
    "archive action taken": "cameras",
    "camera config modified": "cameras",
    "profile image downloaded": "cameras",
    "profile image uploaded": "cameras",
    "profile results searched by identity": "cameras",
    "profile photo added": "cameras",
    "profile created": "cameras",
    "profile deleted": "cameras",
    "profile viewed": "cameras",
    "profile merged": "cameras",
    "profile unmerged": "cameras",
    "profile updated": "cameras",
    "profile searched": "cameras",
    "profile searched with details": "cameras",
    "profile details viewed": "cameras",
    "profile searched by uploading image": "cameras",
    "profile suggestions viewed": "cameras",
    "profile suggestions updated": "cameras",
    "vehicle searched": "cameras",
    "history viewed": "cameras",
    "live stream started": "cameras",
    "embed link created": "cameras",
    "live link created": "cameras",
    "timelapse action taken": "cameras",
    "camera retention settings updated": "cameras",
    "camera site changed": "cameras",
    "helix event modified": "integrations",
    "video sharing agreement updated": "cameras",
    "shared resource created": "cameras",
    # Access
    "access alert modified": "access",
    "aux input modified": "access",
    "door created": "access",
    "door deleted": "access",
    "door modified": "access",
    "door moved": "access",
    "elevator modified": "access",
    "access group user added": "access",
    "access group created": "access",
    "access group user removed": "access",
    "access level modified": "access",
    "access lockdown modified": "access",
    "access muster report modified": "access",
    "access muster template modified": "access",
    "access device nearby camera modified": "access",
    "access org badge template modified": "access",
    "access schedule created": "access",
    "access schedule deleted": "access",
    "access schedule modified": "access",
    "access site config modified": "access",
    "access device moved": "access",
    "access method added": "access",
    "access method removed": "access",
    "access method modified": "access",
    "access roles granted": "access",
    "access roles revoked": "access",
    "access users exported": "access",
    "access org config modified": "access",
    # Alarms / sensors
    "alarm settings modified": "alarms",
    "sensor alert config modified": "sensors",
    "sensor calibration": "sensors",
    "sensor config modified": "sensors",
    "sensor dashboard modified": "sensors",
    "sensor device details modified": "sensors",
    "sensor site changed": "sensors",
}

# Keyword fallback, checked in order. First hit wins, so the specific
# words come before the general ones ("access" would otherwise claim
# "Support Access").
_BY_KEYWORD: tuple[tuple[str, str], ...] = (
    ("support", "support"),
    ("api request", "api"),
    ("api key", "integrations"),
    ("webhook", "integrations"),
    ("helix", "integrations"),
    ("integration", "integrations"),
    ("intercom", "intercoms"),
    ("gateway", "gateway"),
    ("workplace", "workplace"),
    ("guest", "workplace"),
    ("mailroom", "workplace"),
    ("desk", "workplace"),
    ("alarm", "alarms"),
    ("sensor", "sensors"),
    ("door", "access"),
    ("access", "access"),
    ("lockdown", "access"),
    ("badge", "access"),
    ("credential", "access"),
    ("camera", "cameras"),
    ("archive", "cameras"),
    ("profile", "cameras"),
    ("stream", "cameras"),
    ("footage", "cameras"),
    ("video", "cameras"),
    ("timelapse", "cameras"),
    ("vehicle", "cameras"),
    ("plate", "cameras"),
    ("device", "devices"),
    ("license", "admin"),
    ("viewing station", "devices"),
    ("saml", "admin"),
    ("scim", "admin"),
    ("organization", "admin"),
    ("site", "admin"),
    ("user", "users"),
    ("login", "users"),
    ("logout", "users"),
    ("password", "users"),
    ("two-factor", "users"),
)


def categorize(event_name: str | None) -> str:
    name = (event_name or "").strip().lower()
    if not name:
        return "other"
    hit = _BY_NAME.get(name)
    if hit:
        return hit
    for needle, cat in _BY_KEYWORD:
        if needle in name:
            return cat
    return "other"


def actor_kind(entry: dict) -> str:
    """Who did it: a signed-in user, an API key, Verkada Support, or the
    system. Verkada represents "not a user" as the all-zero user id and a
    dash for the name, so those are the tells."""
    name = (entry.get("event_name") or "").strip().lower()
    details = entry.get("details") or {}
    if name == "public api request" or (isinstance(details, dict) and details.get("api_key")):
        return "api_key"
    if entry.get("verkada_support_id"):
        return "support"
    if name.startswith("support access") or name == "device remotely accessed":
        return "support"
    uid = (entry.get("user_id") or "").strip()
    email = (entry.get("user_email") or "").strip()
    uname = (entry.get("user_name") or "").strip()
    if (not uid or uid == "00000000-0000-0000-0000-000000000000") and not email and uname in ("", "-"):
        return "system"
    return "user"
