"""keep historical runs when their flow is deleted

Revision ID: 0014
Revises: 0013
Create Date: 2026-05-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop and re-add the flow_id FK so DELETE on flows no longer cascades
    # the run rows away. Run.flow_id becomes nullable so existing runs keep
    # showing in the Runs UI as "(deleted flow)" instead of vanishing.
    op.alter_column("runs", "flow_id", existing_type=UUID(as_uuid=True), nullable=True)
    op.drop_constraint("runs_flow_id_fkey", "runs", type_="foreignkey")
    op.create_foreign_key(
        "runs_flow_id_fkey",
        "runs",
        "flows",
        ["flow_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("runs_flow_id_fkey", "runs", type_="foreignkey")
    op.create_foreign_key(
        "runs_flow_id_fkey",
        "runs",
        "flows",
        ["flow_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.alter_column("runs", "flow_id", existing_type=UUID(as_uuid=True), nullable=False)
