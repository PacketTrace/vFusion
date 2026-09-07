"""audit_events table — a local, filterable copy of the Command audit log

Revision ID: 0021
Revises: 0020
Create Date: 2026-09-07

Verkada's audit log endpoint accepts only a time range, so filtering by
user, event, device or IP has to happen against rows we hold. The
worker polls the endpoint every ten seconds and lands entries here;
the Explorer's Audit log tab reads only this table.

Additive only: creates one table and its indexes, touches nothing that
exists. Rolling the code back to a build without this file leaves the
table in place (harmless) but alembic will refuse to start on an
unknown head -- reset it with
``UPDATE alembic_version SET version_num = '0020';``.

A trigram index makes substring search fast on a large table. It needs
the ``pg_trgm`` extension, which the stock Postgres image can create;
if this install cannot, the index is skipped and search still works,
just slower.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision: str = "0021"
down_revision: Union[str, None] = "0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("connection_id", UUID(as_uuid=True), nullable=True),
        sa.Column("org_id", sa.String(64), nullable=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "ingested_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("event_name", sa.String(128), nullable=False),
        sa.Column("event_description", sa.String(512), nullable=True),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("actor", sa.String(16), nullable=False),
        sa.Column("user_id", sa.String(64), nullable=True),
        sa.Column("user_name", sa.String(255), nullable=True),
        sa.Column("user_email", sa.String(255), nullable=True),
        sa.Column("ip_address", sa.String(64), nullable=True),
        sa.Column("api_key_name", sa.String(255), nullable=True),
        sa.Column("api_key_tail", sa.String(16), nullable=True),
        sa.Column("method", sa.String(10), nullable=True),
        sa.Column("url_path", sa.String(1024), nullable=True),
        sa.Column("status_code", sa.Integer, nullable=True),
        sa.Column("response_size", sa.Integer, nullable=True),
        sa.Column("is_self", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("device_id", sa.String(64), nullable=True),
        sa.Column("device_name", sa.String(255), nullable=True),
        sa.Column("device_type", sa.String(64), nullable=True),
        sa.Column("device_site", sa.String(255), nullable=True),
        sa.Column("device_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("devices", JSONB, nullable=False, server_default="[]"),
        sa.Column("details", JSONB, nullable=False, server_default="{}"),
        sa.Column("raw", JSONB, nullable=False, server_default="{}"),
        sa.Column("search_text", sa.Text, nullable=False, server_default=""),
    )
    op.create_index("ux_audit_events_fingerprint", "audit_events", ["fingerprint"], unique=True)
    op.create_index("ix_audit_events_timestamp", "audit_events", ["timestamp"])
    op.create_index("ix_audit_events_processed_at", "audit_events", ["processed_at"])
    op.create_index("ix_audit_events_event_name_ts", "audit_events", ["event_name", "timestamp"])
    op.create_index("ix_audit_events_category_ts", "audit_events", ["category", "timestamp"])
    op.create_index("ix_audit_events_user_email_ts", "audit_events", ["user_email", "timestamp"])
    op.create_index("ix_audit_events_ip_ts", "audit_events", ["ip_address", "timestamp"])
    op.create_index("ix_audit_events_api_key_ts", "audit_events", ["api_key_name", "timestamp"])
    op.create_index("ix_audit_events_device_id_ts", "audit_events", ["device_id", "timestamp"])
    op.create_index("ix_audit_events_self_ts", "audit_events", ["is_self", "timestamp"])

    # Best effort; see the module docstring.
    conn = op.get_bind()
    try:
        with conn.begin_nested():
            conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            conn.execute(
                sa.text(
                    "CREATE INDEX ix_audit_events_search_trgm ON audit_events "
                    "USING gin (search_text gin_trgm_ops)"
                )
            )
    except Exception:  # noqa: BLE001 — no extension rights; search falls back to a scan
        pass


def downgrade() -> None:
    op.drop_table("audit_events")
