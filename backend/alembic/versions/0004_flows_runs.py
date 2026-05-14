"""phase 3a: flows + runs

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "flows",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("trigger_type", sa.String(64), nullable=False),
        sa.Column("trigger_config", JSONB, nullable=False, server_default="{}"),
        sa.Column("action_type", sa.String(64), nullable=False),
        sa.Column("action_config", JSONB, nullable=False, server_default="{}"),
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
    op.create_index("ix_flows_enabled", "flows", ["enabled"])

    op.create_table(
        "runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "flow_id",
            UUID(as_uuid=True),
            sa.ForeignKey("flows.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "webhook_event_id",
            UUID(as_uuid=True),
            sa.ForeignKey("webhook_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("input", JSONB, nullable=True),
        sa.Column("output", JSONB, nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "started_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column(
            "finished_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_runs_flow_id", "runs", ["flow_id"])
    op.create_index("ix_runs_status", "runs", ["status"])
    op.create_index("ix_runs_created_at", "runs", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_runs_created_at", table_name="runs")
    op.drop_index("ix_runs_status", table_name="runs")
    op.drop_index("ix_runs_flow_id", table_name="runs")
    op.drop_table("runs")
    op.drop_index("ix_flows_enabled", table_name="flows")
    op.drop_table("flows")
