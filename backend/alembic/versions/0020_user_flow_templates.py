"""user_flow_templates table — user-created flow templates

Revision ID: 0020
Revises: 0019
Create Date: 2026-05-23

Lets operators promote any existing flow into the Templates catalog
without editing JSON files on disk. Built-in templates still live in
backend/app/data/flow_templates/ (read-only); user-created ones land
here so the Reset Everything wipe can clear them and a daily backup
captures them.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_flow_templates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("category", sa.String(64), nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("summary", sa.String(255), nullable=True),
        sa.Column("default_name", sa.String(255), nullable=True),
        # Full template body: trigger_type, trigger_config, nodes, edges.
        # Connection IDs are nulled out before saving, matching the
        # built-in template convention.
        sa.Column("flow", JSONB, nullable=False),
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


def downgrade() -> None:
    op.drop_table("user_flow_templates")
