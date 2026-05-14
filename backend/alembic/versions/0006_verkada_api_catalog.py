"""verkada api catalog (specs + endpoints with change tracking)

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "verkada_api_specs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("namespace", sa.String(64), nullable=False),
        sa.Column("url", sa.String(512), nullable=False),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("api_version", sa.String(32), nullable=True),
        sa.Column("openapi_version", sa.String(16), nullable=True),
        sa.Column("raw_hash", sa.String(64), nullable=True),
        sa.Column("raw", JSONB, nullable=True),
        sa.Column("fetch_status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("fetch_error", sa.Text, nullable=True),
        sa.Column("last_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_unique_constraint("uq_verkada_api_specs_namespace", "verkada_api_specs", ["namespace"])

    op.create_table(
        "verkada_api_endpoints",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "spec_id",
            UUID(as_uuid=True),
            sa.ForeignKey("verkada_api_specs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("namespace", sa.String(64), nullable=False),
        sa.Column("method", sa.String(8), nullable=False),
        sa.Column("path", sa.String(512), nullable=False),
        sa.Column("operation_id", sa.String(255), nullable=True),
        sa.Column("summary", sa.String(512), nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("tags", JSONB, nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("raw", JSONB, nullable=False),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "last_changed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_verkada_api_endpoints_spec_id", "verkada_api_endpoints", ["spec_id"])
    op.create_index("ix_verkada_api_endpoints_namespace", "verkada_api_endpoints", ["namespace"])
    op.create_index(
        "ix_verkada_api_endpoints_method_path",
        "verkada_api_endpoints",
        ["method", "path"],
    )
    op.create_index("ix_verkada_api_endpoints_last_changed_at", "verkada_api_endpoints", ["last_changed_at"])
    op.create_unique_constraint(
        "uq_verkada_api_endpoints_spec_method_path",
        "verkada_api_endpoints",
        ["spec_id", "method", "path"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_verkada_api_endpoints_spec_method_path",
        "verkada_api_endpoints",
        type_="unique",
    )
    op.drop_index("ix_verkada_api_endpoints_last_changed_at", table_name="verkada_api_endpoints")
    op.drop_index("ix_verkada_api_endpoints_method_path", table_name="verkada_api_endpoints")
    op.drop_index("ix_verkada_api_endpoints_namespace", table_name="verkada_api_endpoints")
    op.drop_index("ix_verkada_api_endpoints_spec_id", table_name="verkada_api_endpoints")
    op.drop_table("verkada_api_endpoints")
    op.drop_constraint("uq_verkada_api_specs_namespace", "verkada_api_specs", type_="unique")
    op.drop_table("verkada_api_specs")
