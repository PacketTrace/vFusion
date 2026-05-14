"""connections.setup_complete

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Default existing rows to True (they were created via the manual form).
    # New auto-created connections from webhook ingest will be False until
    # the user supplies an api_key.
    op.add_column(
        "connections",
        sa.Column(
            "setup_complete",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("connections", "setup_complete")
