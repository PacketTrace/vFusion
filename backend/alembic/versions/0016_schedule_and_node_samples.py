"""schedule trigger metadata + per-node captured samples

Revision ID: 0016
Revises: 0015
Create Date: 2026-05-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # last_scheduled_at: tick state for cron-like flows so the worker can
    # decide "have we fired this flow in the current window yet?". NULL
    # means "never fired".
    op.add_column(
        "flows",
        sa.Column(
            "last_scheduled_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    # node_samples: {<node_id>: <captured output>} written by the
    # per-step Run button. Lets the variable picker render real keys
    # for downstream steps without waiting for a full flow run.
    op.add_column(
        "flows",
        sa.Column(
            "node_samples",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'::json"),
        ),
    )


def downgrade() -> None:
    op.drop_column("flows", "node_samples")
    op.drop_column("flows", "last_scheduled_at")
