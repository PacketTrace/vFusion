"""capture webhook image / gif assets to local disk

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "webhook_assets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "webhook_event_id",
            UUID(as_uuid=True),
            sa.ForeignKey("webhook_events.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_url", sa.Text, nullable=False),
        sa.Column("source_field", sa.String(128), nullable=False),
        sa.Column("local_path", sa.String(512), nullable=True),
        sa.Column("content_type", sa.String(128), nullable=True),
        sa.Column("file_size", sa.Integer, nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_webhook_assets_event_id", "webhook_assets", ["webhook_event_id"]
    )
    op.create_index(
        "ix_webhook_assets_expires_at", "webhook_assets", ["expires_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_webhook_assets_expires_at", table_name="webhook_assets")
    op.drop_index("ix_webhook_assets_event_id", table_name="webhook_assets")
    op.drop_table("webhook_assets")
