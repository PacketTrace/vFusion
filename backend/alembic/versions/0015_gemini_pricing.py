"""per-model Gemini pricing snapshot

Revision ID: 0015
Revises: 0014
Create Date: 2026-05-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "gemini_pricing",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("model", sa.String(64), nullable=False, unique=True),
        sa.Column("input_per_1m_usd", sa.Numeric(10, 4), nullable=False),
        sa.Column("output_per_1m_usd", sa.Numeric(10, 4), nullable=False),
        # Some preview models charge a higher rate for long-context prompts.
        # Null when the model uses a single flat rate.
        sa.Column("input_per_1m_long_usd", sa.Numeric(10, 4), nullable=True),
        sa.Column("output_per_1m_long_usd", sa.Numeric(10, 4), nullable=True),
        sa.Column("long_threshold_tokens", sa.Integer, nullable=True),
        sa.Column("source", sa.String(255), nullable=False, server_default="hardcoded"),
        sa.Column(
            "fetched_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("gemini_pricing")
