"""
Verkada webhook event schemas.

Every Verkada webhook shares a common envelope:

    {
      "org_id": "...",
      "webhook_id": "...",
      "webhook_type": "notification" | "lpr" | "sensor_alert" | "credential-notification",
      "created_at": <unix-seconds>,
      "data": { ... }
    }

The shape of ``data`` varies by ``webhook_type``, and for ``notification`` it
further splits by ``data.notification_type``. We group these into seven families:

    1. camera     — camera AI events (motion, POI, LPR-of-interest, tamper, etc.)
    2. access     — door / ACU events (door_opened, BLE unlock, NFC scan, etc.)
    3. lpr        — raw LPR detections (webhook_type=lpr, no notification_type)
    4. sensor     — environmental sensor alerts (webhook_type=sensor_alert)
    5. intercom   — intercom call/missed-call events
    6. credential — credential lifecycle events (created/updated/deleted),
                     uses webhook_type=credential-notification with a different
                     camelCase data shape (events[], eventType, grantorId, …)
    7. alarm      — Alarms: site state changes (arm/disarm) and incident events
                     (panic, trigger, resolved). Two outer webhook_types fall
                     here: alarm_site_state_changed + new_alarms.

Derived from 10K real captures (2026-05). See fixtures/ for one canonical
sample per family/variant.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field


CAMERA_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "alert_rule_motion",
        "alert_rule_line_crossing",
        "alert_rule_activity_recognition",
        "alert_rule_crowd",
        "alert_rule_dwell",
        "alert_rule_inactivity",
        "contextual_trigger_people_motion",
        "natural_language_event",
        "person_of_interest",
        "license_plate_of_interest",
        # Smart List match — a face/plate/object that hit a configured
        # Command "Smart List." Carries the same camera_id / image_url /
        # video_url shape as the other camera notifications; ``objects``
        # may be empty (face-list matches don't populate it).
        "smart_list",
        "tamper",
        "occlusion",
        "custom_event",
        "camera_status",
    }
)

ACCESS_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "door_opened",
        "door_held_open",
        "door_auxoutput_activated",
        "door_auxoutput_deactivated",
        "door_mobile_nfc_scan_accepted",
        "door_mobile_nfc_scan_rejected",
        "door_remote_unlock_accepted",
        "door_ble_unlock_attempt_accepted",
        "door_ble_unlock_attempt_rejected",
        "door_keycard_entered_accepted",
        "door_keycard_entered_rejected",
        "door_code_entered_rejected",
        "door_forced_open",
        "door_face_presented_accepted",
        "door_face_presented_rejected",
        "door_lp_presented_accepted",
        "door_lp_presented_rejected",
        "door_deactivated_credential_used",
        "door_tailgating",
        "door_acu_offline",
        "door_schedule_override_removed",
        # Lockdown lifecycle — fired when an Access scenario locks a
        # door (and a debounced variant Verkada emits to suppress
        # duplicate rapid-fire events). Carry lockdown_info +
        # scenario_info; door_id may be null on the debounced one.
        "door_lockdown",
        "door_lockdown_debounced",
        # Door position / lock-state lifecycle — the plain state
        # transitions (closed / locked / unlocked), same AccessEventData
        # shape as door_opened. Observed 2026-09 captures.
        "door_closed",
        "door_locked",
        "door_unlocked",
        # Successful keypad entry — the accepted twin of
        # door_code_entered_rejected (already above). ``input_value``
        # carries the entered code as a string; treat it as a secret
        # (real captures contain live door PINs).
        "door_code_entered_accepted",
    }
)

INTERCOM_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "intercom_missed_call",
        "intercom_call_triggered",
        "intercom_receiver_admitted",
        "intercom_status",
    }
)


# Alarm-family webhook types (outer ``webhook_type`` discriminator,
# similar to lpr / sensor_alert — no nested notification_type). Covers
# both site state changes (arm/disarm) and actual incident events from
# Verkada Alarms.
ALARM_WEBHOOK_TYPES: frozenset[str] = frozenset(
    {
        "alarm_site_state_changed",
        "new_alarms",
    }
)


class Envelope(BaseModel):
    """Common outer envelope for every Verkada webhook."""

    org_id: str
    webhook_id: str
    webhook_type: str
    created_at: int
    data: dict[str, Any]


class DoorInfoSite(BaseModel):
    name: str | None = None
    site_id: str | None = None


class DoorInfo(BaseModel):
    acu_name: str | None = None
    acu_id: str | None = None
    name: str | None = None
    door_id: str | None = None
    site: DoorInfoSite | None = None
    api_control_enabled: bool | None = None
    camera_info: Any | None = None
    timezone: str | None = None


class AccessEventData(BaseModel):
    event_id: str
    device_id: str
    created: int
    notification_type: str
    device_type: Literal["access_control"]
    door_id: str | None = None
    direction: str | None = None
    input_value: Any | None = None
    aux_info: Any | None = None
    # Present (null so far) on the door state-transition events
    # (door_closed / door_locked / door_unlocked / door_code_entered_*).
    area_info: Any | None = None
    user_info: Any | None = None
    lockdown_info: Any | None = None
    scenario_info: Any | None = None
    door_info: DoorInfo | None = None


class CameraEventData(BaseModel):
    event_id: str
    device_id: str
    created: int
    notification_type: str
    device_type: Literal["camera"]
    camera_id: str
    person_label: str | None = None
    objects: list[Any] = Field(default_factory=list)
    crowd_threshold: float | int | None = None
    image_url: str | None = None
    video_url: str | None = None
    event_description: str | None = None
    license_plate_number: str | None = None
    license_plate_state: str | None = None
    location: str | None = None
    location_lon: float | None = None
    location_lat: float | None = None
    camera_status: str | None = None


class LPRData(BaseModel):
    camera_id: str
    created: int
    detected: int
    license_plate_number: str
    confidence: float
    crop: list[float]
    image_url: str | None = None
    license_plate_state: str | None = None
    license_plate_state_confidence: float | None = None
    vehicle_image_url: str | None = None


class SensorAlertData(BaseModel):
    alert_event_id: str
    device_id: str
    device_name: str | None = None
    device_serial: str | None = None
    start_time: int
    end_time: int | None = None
    reading: str
    threshold: float
    most_extreme_value: float
    is_above_max_event: bool


class IntercomEventData(BaseModel):
    event_id: str
    device_id: str
    created: int
    notification_type: str
    device_type: str | None = None
    device_name: str | None = None
    start_timestamp: int | None = None
    end_timestamp: int | None = None
    answered_timestamp: int | None = None
    answered_by_name: str | None = None


class AlarmSiteStateChangedData(BaseModel):
    """webhook_type=alarm_site_state_changed — site arm/disarm/state events."""

    site_id: str
    site_name: str | None = None
    timestamp: int
    event_type: str  # "armed" | "disarmed" | etc.
    site_state: str
    site_security_level: str | None = None


class NewAlarmEventData(BaseModel):
    """webhook_type=new_alarms — actual alarm incidents (panic button,
    trigger fired, alarm resolved, etc.)."""

    alarm_id: str
    site_id: str
    site_name: str | None = None
    event_time: int
    event_type: str  # "alarm_resolved" | "alarm_triggered" | etc.
    response_id: str | None = None
    partition_id: str | None = None
    partition_name: str | None = None
    response_level: str | None = None
    trigger_type: str | None = None
    trigger_time: int | None = None
    trigger_device_id: str | None = None
    trigger_device_name: str | None = None
    trigger_device_type: str | None = None
    context_camera_ids: list[str] = Field(default_factory=list)
    incident_link: str | None = None
    is_silent: bool | None = None


class CredentialEventData(BaseModel):
    """Credential lifecycle webhook (webhook_type=credential-notification).

    Different camelCase shape from the other Verkada webhooks: a top-level
    ``eventType`` discriminator ("CREDENTIAL_CREATED" etc.) and a nested
    ``events`` list with per-credential detail. Issued by Verkada Access
    when a credential is created / modified / revoked / etc.
    """

    eventId: str
    eventType: str  # e.g. "CREDENTIAL_CREATED", "CREDENTIAL_UPDATED"
    timestamp: str  # ISO 8601, unlike the int-epoch used elsewhere
    grantorId: str
    grantorEmployeeId: str | None = None
    grantorExternalId: str | None = None
    events: list[Any] = Field(default_factory=list)


Family = Literal[
    "camera", "access", "lpr", "sensor", "intercom", "credential", "alarm", "unknown"
]


def classify(envelope: Envelope) -> Family:
    """Bucket an envelope into one of the seven known families (or ``unknown``)."""
    if envelope.webhook_type == "lpr":
        return "lpr"
    if envelope.webhook_type == "sensor_alert":
        return "sensor"
    if envelope.webhook_type == "credential-notification":
        return "credential"
    if envelope.webhook_type in ALARM_WEBHOOK_TYPES:
        return "alarm"
    if envelope.webhook_type == "notification":
        nt = envelope.data.get("notification_type") if isinstance(envelope.data, dict) else None
        if nt in CAMERA_EVENT_TYPES:
            return "camera"
        if nt in ACCESS_EVENT_TYPES:
            return "access"
        if nt in INTERCOM_EVENT_TYPES:
            return "intercom"
    return "unknown"


# Human labels for the raw notification_type strings.
#
# The wire values are fine as identifiers and unreadable as UI: nobody
# scanning a dropdown knows that "alert_rule_dwell" is the thing Command
# calls Loitering. Names here follow Verkada's own product language where
# it exists — their alerts API enumerates crowd / loitering / line_crossing
# / tamper, and the access playbook groups door events into successful
# entry, denied attempts, physical exceptions and hardware.
#
# (label, one-line description, group). Group drives <optgroup> ordering.
NOTIFICATION_TYPE_META: dict[str, tuple[str, str, str]] = {
    # ---- camera ----
    "alert_rule_motion": ("Motion", "Something moved in a monitored area.", "Detections"),
    "contextual_trigger_people_motion": ("Person motion", "Motion specifically attributed to a person.", "Detections"),
    "alert_rule_line_crossing": ("Line crossing", "Something crossed a line drawn on the camera view.", "Detections"),
    "alert_rule_dwell": ("Loitering", "Someone stayed in an area longer than the configured dwell time.", "Detections"),
    "alert_rule_crowd": ("Crowd forming", "More people in view than the configured crowd threshold.", "Detections"),
    "alert_rule_inactivity": ("Inactivity", "An area that normally sees activity has gone quiet.", "Detections"),
    "alert_rule_activity_recognition": ("Activity recognised", "A configured activity type was recognised in view.", "Detections"),
    "natural_language_event": ("Natural-language match", "Footage matched a plain-language search you saved.", "Detections"),
    "person_of_interest": ("Person of Interest seen", "A face matched someone on a Person of Interest list.", "Watchlists"),
    "license_plate_of_interest": ("Plate of Interest seen", "A plate matched a License Plate of Interest list.", "Watchlists"),
    "smart_list": ("Smart List match", "A face, plate or object matched a Smart List.", "Watchlists"),
    "tamper": ("Camera tampered with", "The camera was moved, covered or otherwise interfered with.", "Device health"),
    "occlusion": ("View blocked", "Something is obstructing the camera's view.", "Device health"),
    "camera_status": ("Camera went online / offline", "The camera changed connection state.", "Device health"),
    "custom_event": ("Custom event", "An event your own integration raised.", "Other"),
    # ---- access: it worked ----
    "door_opened": ("Door opened", "The door physically opened.", "Entry"),
    "door_unlocked": ("Door unlocked", "The lock released.", "Entry"),
    "door_keycard_entered_accepted": ("Badge accepted", "A keycard was presented and granted.", "Entry"),
    "door_code_entered_accepted": ("Keypad code accepted", "A PIN was entered and granted.", "Entry"),
    "door_mobile_nfc_scan_accepted": ("Phone tap accepted", "A mobile NFC credential was granted.", "Entry"),
    "door_ble_unlock_attempt_accepted": ("Bluetooth unlock accepted", "An unlock from the Pass app was granted.", "Entry"),
    "door_face_presented_accepted": ("Face accepted", "Face authentication succeeded.", "Entry"),
    "door_lp_presented_accepted": ("Plate accepted", "A license plate credential was granted.", "Entry"),
    "door_remote_unlock_accepted": ("Remote unlock accepted", "Someone unlocked the door from Command or the API.", "Entry"),
    # ---- access: it didn't ----
    "door_keycard_entered_rejected": ("Badge rejected", "A keycard was presented and denied.", "Denied"),
    "door_code_entered_rejected": ("Keypad code rejected", "A PIN was entered and denied.", "Denied"),
    "door_mobile_nfc_scan_rejected": ("Phone tap rejected", "A mobile NFC credential was denied.", "Denied"),
    "door_ble_unlock_attempt_rejected": ("Bluetooth unlock rejected", "An unlock from the Pass app was denied.", "Denied"),
    "door_face_presented_rejected": ("Face rejected", "Face authentication failed.", "Denied"),
    "door_lp_presented_rejected": ("Plate rejected", "A license plate credential was denied.", "Denied"),
    "door_deactivated_credential_used": ("Deactivated credential used", "Someone tried a credential that has been turned off.", "Denied"),
    # ---- access: physical exceptions ----
    "door_forced_open": ("Door forced open", "The door opened without being unlocked.", "Exceptions"),
    "door_held_open": ("Door held open", "The door stayed open longer than allowed.", "Exceptions"),
    "door_tailgating": ("Tailgating", "More people went through than credentials presented.", "Exceptions"),
    # ---- access: state and hardware ----
    "door_closed": ("Door closed", "The door returned to closed.", "Door state"),
    "door_locked": ("Door locked", "The lock engaged.", "Door state"),
    "door_lockdown": ("Lockdown applied", "An Access scenario locked this door.", "Door state"),
    "door_lockdown_debounced": ("Lockdown (repeat suppressed)", "A duplicate lockdown event Verkada collapsed.", "Door state"),
    "door_schedule_override_removed": ("Schedule override cleared", "A manual override of the door schedule ended.", "Door state"),
    "door_auxoutput_activated": ("Aux output on", "An auxiliary output on the controller switched on.", "Hardware"),
    "door_auxoutput_deactivated": ("Aux output off", "An auxiliary output on the controller switched off.", "Hardware"),
    "door_acu_offline": ("Controller offline", "The access control unit lost connection.", "Hardware"),
    # ---- intercom ----
    "intercom_call_triggered": ("Someone rang the intercom", "A visitor pressed the call button.", "Calls"),
    "intercom_missed_call": ("Intercom call missed", "Nobody answered the intercom.", "Calls"),
    "intercom_receiver_admitted": ("Visitor admitted", "Someone answered and let the visitor in.", "Calls"),
    "intercom_status": ("Intercom went online / offline", "The intercom changed connection state.", "Device health"),
}


def notification_type_meta(nt: str) -> dict[str, str]:
    """Label/description/group for a notification type.

    Falls back to a de-underscored version of the raw value so a type
    Verkada adds tomorrow still reads sensibly instead of vanishing.
    """
    hit = NOTIFICATION_TYPE_META.get(nt)
    if hit:
        return {"label": hit[0], "description": hit[1], "group": hit[2]}
    return {
        "label": nt.replace("alert_rule_", "").replace("_", " ").capitalize(),
        "description": "",
        "group": "Other",
    }


# Surfaced to the frontend so the trigger node can render family choices
# and field-level filter pickers without hardcoding strings in JS.
TAXONOMY: dict[str, dict[str, Any]] = {
    "camera": {
        "label": "Camera event",
        "webhook_type": "notification",
        "notification_types": sorted(CAMERA_EVENT_TYPES),
        "notification_type_meta": {
            nt: notification_type_meta(nt) for nt in sorted(CAMERA_EVENT_TYPES)
        },
        # The picker is sample-driven, so each of these only surfaces when
        # an actual webhook of the selected notification_type carries the
        # field. Ordering here is "most likely to be the meaningful filter
        # for the type the user picked":
        #   - alert_rule_motion → objects
        #   - person_of_interest → person_label
        #   - LPR-flavored camera events → license_plate_number
        #   - camera_id is the universal fallback for "this camera only".
        "filter_fields": [
            "objects",
            "person_label",
            "license_plate_number",
            "camera_id",
        ],
    },
    "access": {
        "label": "Access / Door Event",
        "webhook_type": "notification",
        "notification_types": sorted(ACCESS_EVENT_TYPES),
        "notification_type_meta": {
            nt: notification_type_meta(nt) for nt in sorted(ACCESS_EVENT_TYPES)
        },
        "filter_fields": ["door_id", "user_info", "direction"],
    },
    "lpr": {
        "label": "LPR Detection (raw)",
        "webhook_type": "lpr",
        "notification_types": None,
        "filter_fields": ["license_plate_number", "license_plate_state", "camera_id"],
    },
    "sensor": {
        "label": "Sensor Alert",
        "webhook_type": "sensor_alert",
        "notification_types": None,
        "filter_fields": ["reading", "device_name", "is_above_max_event"],
    },
    "intercom": {
        "label": "Intercom Event",
        "webhook_type": "notification",
        "notification_types": sorted(INTERCOM_EVENT_TYPES),
        "notification_type_meta": {
            nt: notification_type_meta(nt) for nt in sorted(INTERCOM_EVENT_TYPES)
        },
        "filter_fields": ["device_name", "answered_by_name"],
    },
    "credential": {
        "label": "Credential Lifecycle",
        "webhook_type": "credential-notification",
        "notification_types": None,
        "filter_fields": ["eventType", "grantorId"],
    },
    "alarm": {
        "label": "Alarms",
        # Two webhook_types fall into this bucket — site state changes
        # (arm/disarm) and incident events (panic, trigger, resolved).
        # Frontend filter uses the webhook_type field on the inbox row
        # to drill into one or the other.
        "webhook_type": sorted(ALARM_WEBHOOK_TYPES),
        "notification_types": None,
        "filter_fields": [
            "site_id",
            "site_name",
            "event_type",
            "trigger_type",
            "trigger_device_name",
        ],
    },
}
