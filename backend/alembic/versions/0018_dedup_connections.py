"""Dedup verkada connections + unique (type, external_id).

Revision ID: 0018
Revises: 0017
Create Date: 2026-05-22

Concurrent webhooks from a brand-new Verkada org raced inside
``_get_or_autocreate_connection``: each request's SELECT ran before the
others' INSERT committed, so all of them missed the existing row and a
single org spawned several stub Connection rows.

This migration collapses any existing duplicates (keeping the earliest
row per type + external_id) and adds a partial unique index so the DB
rejects the race going forward. The index is partial on
``external_id IS NOT NULL`` because 3rd-party connections (Gemini) have
no external_id and several of them must be allowed to coexist.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Collapse duplicates: delete every row that has an earlier sibling
    # (same type + external_id). Auto-created stubs are credential-less
    # and carry no synced cameras/doors yet, so dropping the extras is
    # safe — the surviving row keeps the org's place.
    op.execute(
        """
        DELETE FROM connections AS dup
        USING connections AS keep
        WHERE dup.type = keep.type
          AND dup.external_id = keep.external_id
          AND dup.external_id IS NOT NULL
          AND (keep.created_at, keep.id) < (dup.created_at, dup.id)
        """
    )
    op.create_index(
        "uq_connections_type_external_id",
        "connections",
        ["type", "external_id"],
        unique=True,
        postgresql_where=sa.text("external_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_connections_type_external_id", table_name="connections")
