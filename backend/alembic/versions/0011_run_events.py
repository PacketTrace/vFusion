"""live progress events for a Run

Revision ID: 0011
Revises: 0010
Create Date: 2026-05-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "run_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "run_id",
            UUID(as_uuid=True),
            sa.ForeignKey("runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("step_name", sa.String(255), nullable=True),
        sa.Column("phase", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=True),
        sa.Column("message", sa.Text, nullable=True),
        sa.Column(
            "ts",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_run_events_run_id_ts", "run_events", ["run_id", "ts"])


def downgrade() -> None:
    op.drop_index("ix_run_events_run_id_ts", table_name="run_events")
    op.drop_table("run_events")
