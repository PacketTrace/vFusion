"""phase 2: connections + webhook_events classification

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


CAMERA_TYPES = (
    "alert_rule_motion",
    "alert_rule_line_crossing",
    "alert_rule_activity_recognition",
    "natural_language_event",
    "person_of_interest",
    "license_plate_of_interest",
    "tamper",
    "occlusion",
    "custom_event",
    "camera_status",
)
ACCESS_TYPES = (
    "door_opened",
    "door_held_open",
    "door_auxoutput_activated",
    "door_auxoutput_deactivated",
    "door_mobile_nfc_scan_accepted",
    "door_remote_unlock_accepted",
    "door_ble_unlock_attempt_accepted",
    "door_ble_unlock_attempt_rejected",
    "door_acu_offline",
)
INTERCOM_TYPES = ("intercom_missed_call", "intercom_call_triggered")


def _sql_array(items):
    return "(" + ", ".join(f"'{t}'" for t in items) + ")"


def upgrade() -> None:
    # ---- webhook_events: new classification columns ----
    op.add_column("webhook_events", sa.Column("family", sa.String(32), nullable=True))
    op.add_column(
        "webhook_events", sa.Column("notification_type", sa.String(64), nullable=True)
    )
    op.add_column(
        "webhook_events", sa.Column("webhook_type", sa.String(64), nullable=True)
    )
    op.add_column("webhook_events", sa.Column("org_id", sa.String(255), nullable=True))
    op.add_column(
        "webhook_events", sa.Column("signature_status", sa.String(32), nullable=True)
    )
    op.create_index("ix_webhook_events_family", "webhook_events", ["family"])
    op.create_index(
        "ix_webhook_events_notification_type", "webhook_events", ["notification_type"]
    )
    op.create_index("ix_webhook_events_org_id", "webhook_events", ["org_id"])

    # ---- backfill existing rows from body_json ----
    # Two separate UPDATEs because asyncpg's prepared-statement protocol
    # doesn't allow multiple commands in one execute() call.
    op.execute(
        f"""
        UPDATE webhook_events
        SET
            webhook_type      = body_json->>'webhook_type',
            org_id            = body_json->>'org_id',
            notification_type = body_json->'data'->>'notification_type',
            family = CASE
                WHEN body_json->>'webhook_type' = 'lpr' THEN 'lpr'
                WHEN body_json->>'webhook_type' = 'sensor_alert' THEN 'sensor'
                WHEN body_json->>'webhook_type' = 'notification'
                     AND body_json->'data'->>'notification_type' IN {_sql_array(CAMERA_TYPES)}
                     THEN 'camera'
                WHEN body_json->>'webhook_type' = 'notification'
                     AND body_json->'data'->>'notification_type' IN {_sql_array(ACCESS_TYPES)}
                     THEN 'access'
                WHEN body_json->>'webhook_type' = 'notification'
                     AND body_json->'data'->>'notification_type' IN {_sql_array(INTERCOM_TYPES)}
                     THEN 'intercom'
                ELSE 'unknown'
            END
        WHERE body_json IS NOT NULL
        """
    )
    # Catch non-JSON / non-envelope rows so the UI can surface them.
    op.execute("UPDATE webhook_events SET family = 'unknown' WHERE family IS NULL")

    # ---- connections table ----
    op.create_table(
        "connections",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("type", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("external_id", sa.String(255), nullable=True),
        sa.Column("encrypted_secret", sa.Text, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_connections_type", "connections", ["type"])
    op.create_index("ix_connections_external_id", "connections", ["external_id"])


def downgrade() -> None:
    op.drop_index("ix_connections_external_id", table_name="connections")
    op.drop_index("ix_connections_type", table_name="connections")
    op.drop_table("connections")

    op.drop_index("ix_webhook_events_org_id", table_name="webhook_events")
    op.drop_index("ix_webhook_events_notification_type", table_name="webhook_events")
    op.drop_index("ix_webhook_events_family", table_name="webhook_events")
    op.drop_column("webhook_events", "signature_status")
    op.drop_column("webhook_events", "org_id")
    op.drop_column("webhook_events", "webhook_type")
    op.drop_column("webhook_events", "notification_type")
    op.drop_column("webhook_events", "family")
