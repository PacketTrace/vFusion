"""verkada_doors cache + connections.doors_last_synced_at

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "connections",
        sa.Column("doors_last_synced_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "verkada_doors",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "connection_id",
            UUID(as_uuid=True),
            sa.ForeignKey("connections.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("door_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column("site", sa.String(255), nullable=True),
        sa.Column("site_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(32), nullable=True),
        sa.Column("acu_id", sa.String(64), nullable=True),
        sa.Column("acu_name", sa.String(255), nullable=True),
        sa.Column("raw", JSONB, nullable=True),
        sa.Column(
            "synced_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_verkada_doors_connection_id", "verkada_doors", ["connection_id"])
    op.create_index("ix_verkada_doors_door_id", "verkada_doors", ["door_id"])
    op.create_unique_constraint(
        "uq_verkada_doors_conn_door",
        "verkada_doors",
        ["connection_id", "door_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_verkada_doors_conn_door", "verkada_doors", type_="unique")
    op.drop_index("ix_verkada_doors_door_id", table_name="verkada_doors")
    op.drop_index("ix_verkada_doors_connection_id", table_name="verkada_doors")
    op.drop_table("verkada_doors")
    op.drop_column("connections", "doors_last_synced_at")
