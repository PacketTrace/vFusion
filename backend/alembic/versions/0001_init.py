"""init webhook_events

Revision ID: 0001
Revises:
Create Date: 2026-05-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "webhook_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(255), nullable=False),
        sa.Column("method", sa.String(10), nullable=False),
        sa.Column("path", sa.String(1024), nullable=False),
        sa.Column("query_string", sa.String(2048), nullable=False, server_default=""),
        sa.Column("headers", JSONB, nullable=False, server_default="{}"),
        sa.Column("body_json", JSONB, nullable=True),
        sa.Column("body_text", sa.Text, nullable=True),
        sa.Column("body_size", sa.Integer, nullable=False, server_default="0"),
        sa.Column("remote_addr", sa.String(64), nullable=True),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_webhook_events_slug", "webhook_events", ["slug"])
    op.create_index(
        "ix_webhook_events_received_at", "webhook_events", ["received_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_webhook_events_received_at", table_name="webhook_events")
    op.drop_index("ix_webhook_events_slug", table_name="webhook_events")
    op.drop_table("webhook_events")
