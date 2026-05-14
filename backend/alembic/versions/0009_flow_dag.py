"""flows become DAGs (nodes + edges) instead of lists

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "flows",
        sa.Column("nodes", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )
    op.add_column(
        "flows",
        sa.Column("edges", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )

    # Backfill: turn each step in `actions` into a node, with linear edges
    # connecting consecutive steps.
    op.execute(
        """
        UPDATE flows
        SET nodes = COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', step->>'name',
                    'name', step->>'name',
                    'kind', 'action',
                    'action_type', step->>'type',
                    'config', COALESCE(step->'config', '{}'::jsonb)
                )
                ORDER BY ord
            )
            FROM jsonb_array_elements(actions) WITH ORDINALITY AS t(step, ord)
        ), '[]'::jsonb)
        """
    )
    op.execute(
        """
        UPDATE flows
        SET edges = COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', concat('e-', cur->>'name', '-', nxt->>'name'),
                    'source', cur->>'name',
                    'target', nxt->>'name'
                )
                ORDER BY ord
            )
            FROM jsonb_array_elements(actions) WITH ORDINALITY AS c(cur, ord)
            JOIN jsonb_array_elements(actions) WITH ORDINALITY AS n(nxt, ord2)
              ON ord + 1 = ord2
        ), '[]'::jsonb)
        """
    )

    op.drop_column("flows", "actions")


def downgrade() -> None:
    op.add_column(
        "flows",
        sa.Column("actions", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )
    # Best-effort: rebuild a linear list by walking edges from each root.
    # Downgrades on real DAGs (with branches) will lose information.
    op.execute(
        """
        UPDATE flows
        SET actions = COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'name', node->>'name',
                    'type', COALESCE(node->>'action_type', node->>'kind'),
                    'config', COALESCE(node->'config', '{}'::jsonb)
                )
            )
            FROM jsonb_array_elements(nodes) AS node
        ), '[]'::jsonb)
        """
    )
    op.drop_column("flows", "edges")
    op.drop_column("flows", "nodes")
