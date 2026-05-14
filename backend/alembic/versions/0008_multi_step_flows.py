"""multi-step flows: actions[] + per-step run results

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ---- flows: replace single action with an actions list ----
    op.add_column(
        "flows",
        sa.Column("actions", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )
    # Backfill existing single-action flows into a one-element array.
    op.execute(
        """
        UPDATE flows
        SET actions = jsonb_build_array(
            jsonb_build_object(
                'name', 'step_1',
                'type', action_type,
                'config', COALESCE(action_config, '{}'::jsonb)
            )
        )
        WHERE action_type IS NOT NULL
        """
    )
    op.drop_column("flows", "action_type")
    op.drop_column("flows", "action_config")

    # ---- runs: per-step results ----
    op.add_column(
        "runs",
        sa.Column("steps", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )


def downgrade() -> None:
    op.add_column("flows", sa.Column("action_type", sa.String(64), nullable=True))
    op.add_column("flows", sa.Column("action_config", JSONB, nullable=True))
    # Best-effort backfill from the first action in the array.
    op.execute(
        """
        UPDATE flows
        SET action_type = (actions->0->>'type'),
            action_config = COALESCE(actions->0->'config', '{}'::jsonb)
        WHERE jsonb_array_length(actions) > 0
        """
    )
    op.drop_column("flows", "actions")
    op.drop_column("runs", "steps")
