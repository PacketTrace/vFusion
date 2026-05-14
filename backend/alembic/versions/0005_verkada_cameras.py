"""phase 3.5: verkada_cameras cache

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "connections",
        sa.Column("cameras_last_synced_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "verkada_cameras",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "connection_id",
            UUID(as_uuid=True),
            sa.ForeignKey("connections.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("camera_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column("site", sa.String(255), nullable=True),
        sa.Column("site_id", sa.String(64), nullable=True),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("serial", sa.String(64), nullable=True),
        sa.Column("status", sa.String(32), nullable=True),
        sa.Column("location", sa.Text(), nullable=True),
        sa.Column("raw", JSONB, nullable=True),
        sa.Column(
            "synced_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_verkada_cameras_connection_id", "verkada_cameras", ["connection_id"]
    )
    op.create_index("ix_verkada_cameras_camera_id", "verkada_cameras", ["camera_id"])
    op.create_unique_constraint(
        "uq_verkada_cameras_conn_cam",
        "verkada_cameras",
        ["connection_id", "camera_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_verkada_cameras_conn_cam", "verkada_cameras", type_="unique"
    )
    op.drop_index("ix_verkada_cameras_camera_id", table_name="verkada_cameras")
    op.drop_index("ix_verkada_cameras_connection_id", table_name="verkada_cameras")
    op.drop_table("verkada_cameras")
    op.drop_column("connections", "cameras_last_synced_at")
