"""sync helix event types per Verkada connection

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "verkada_helix_event_types",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "connection_id",
            UUID(as_uuid=True),
            sa.ForeignKey("connections.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("org_id", sa.String(64), nullable=False),
        sa.Column("event_type_uid", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column("event_schema", JSONB, nullable=True),
        sa.Column(
            "last_synced_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("connection_id", "event_type_uid", name="uq_helix_event_per_conn"),
    )
    op.create_index(
        "ix_helix_event_types_connection_id",
        "verkada_helix_event_types",
        ["connection_id"],
    )
    op.add_column(
        "connections",
        sa.Column(
            "helix_events_last_synced_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("connections", "helix_events_last_synced_at")
    op.drop_index(
        "ix_helix_event_types_connection_id",
        table_name="verkada_helix_event_types",
    )
    op.drop_table("verkada_helix_event_types")
