# Verkada connector

Schemas and reference payloads for Verkada's outbound webhooks. Use this as the source of truth when building trigger/action nodes for Verkada events.

## Envelope

Every Verkada webhook arrives as `POST application/json` with this shape:

```json
{
  "org_id": "...",
  "webhook_id": "...",
  "webhook_type": "notification | lpr | sensor_alert",
  "created_at": 1700000000,
  "data": { ... }
}
```

A `verkada-signature` header is included for HMAC verification (added in Phase 2).

## Five families

| Family   | webhook_type    | Distinguisher                    | Lives in `data`                                          |
|----------|-----------------|----------------------------------|----------------------------------------------------------|
| camera   | `notification`  | `data.notification_type ∈ CAMERA_EVENT_TYPES` | event_id, camera_id, person_label, image_url, video_url, ... |
| access   | `notification`  | `data.notification_type ∈ ACCESS_EVENT_TYPES` | door_id, door_info, user_info, scenario_info, ...        |
| lpr      | `lpr`           | (no notification_type)           | license_plate_number, confidence, crop, vehicle_image_url |
| sensor   | `sensor_alert`  | (no notification_type)           | reading, threshold, most_extreme_value, is_above_max_event |
| intercom | `notification`  | `data.notification_type ∈ INTERCOM_EVENT_TYPES` | start_timestamp, answered_by_name, ...                    |

Use `classify(envelope)` to bucket. The `TAXONOMY` dict is exposed to the frontend so the trigger node can render family/event pickers without hardcoded strings.

## Fixtures

`fixtures/` contains one anonymized sample per notable variant. UUIDs, URLs, and human-readable names are fake but the structure mirrors real captures.

| File                                      | Family   | Use case                                               |
|-------------------------------------------|----------|--------------------------------------------------------|
| `alert_rule_motion.json`                  | camera   | Most common — motion detected on a camera              |
| `person_of_interest.json`                 | camera   | POI face match (the "POI=name → unlock door" flow)     |
| `license_plate_of_interest.json`          | camera   | Matched LPR plate flagged as an "of interest" alert    |
| `lpr.json`                                | lpr      | Raw plate detection (every read, not just matches)     |
| `door_opened.json`                        | access   | Door opened — includes rich `door_info`                |
| `door_remote_unlock_accepted.json`        | access   | The action target — confirms successful remote unlock  |
| `sensor_alert.json`                       | sensor   | Environmental sensor crossed threshold (e.g. noise)    |
| `intercom_call_triggered.json`            | intercom | Visitor pressed intercom                               |

These double as test fixtures: load any file, feed it to `Envelope.model_validate(json.load(...))`, and run `classify()` to confirm bucketing.

## Adding new event types

When you observe a `notification_type` not yet in the constants in `schemas.py`:

1. Add it to the appropriate `*_EVENT_TYPES` frozenset.
2. If its `data` shape differs from existing family members, add a new Pydantic model and update `classify()`.
3. Add a fixture with realistic-but-fake values.
