"""mcp_tool_observations — track when each MCP tool first appeared

Revision ID: 0021
Revises: 0020
Create Date: 2026-09-02

MCP exposes no timestamps: a tools/list entry carries only name,
description, inputSchema and annotations, and Verkada's server reports
its version as "dev". So "when did this tool show up" can only be
answered by watching the catalog over time and recording what changed.

One row per (server_url, tool_name). Everything present the first time we
look at a server is flagged is_baseline — we have no history before that
moment, so those are reported as "original" rather than given a
misleading date. Tools that appear later get a real first_seen_at.
schema_hash lets us notice a tool's description or input schema being
edited in place, which is the other way a server changes without any
tool being added or removed.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "0021"
down_revision: Union[str, None] = "0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "mcp_tool_observations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("server_url", sa.String(512), nullable=False),
        sa.Column("tool_name", sa.String(255), nullable=False),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # True for tools present in the very first catalog we ever fetched
        # from this server — their real add date predates our records.
        sa.Column(
            "is_baseline",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        # sha256 over description + inputSchema + annotations, so an
        # in-place edit is detectable.
        sa.Column("schema_hash", sa.String(64), nullable=False),
        sa.Column("schema_changed_at", sa.DateTime(timezone=True), nullable=True),
        # Set when a previously-seen tool stops appearing; cleared if it
        # comes back.
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("server_url", "tool_name", name="uq_mcp_tool_obs"),
    )
    op.create_index(
        "ix_mcp_tool_observations_server_url",
        "mcp_tool_observations",
        ["server_url"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_mcp_tool_observations_server_url", table_name="mcp_tool_observations"
    )
    op.drop_table("mcp_tool_observations")
