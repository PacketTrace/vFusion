from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, String, DateTime, Boolean
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class Flow(Base):
    """A trigger + a DAG of nodes connected by edges.

    Each node has ``{id, name, kind, action_type?, config}``.
    Each edge has ``{id, source, target, branch?}`` where ``branch`` is
    ``"true"`` or ``"false"`` (only meaningful from condition nodes).

    The engine runs the DAG in topological order. A node runs when at
    least one of its incoming edges has a successful source AND the edge's
    branch (if any) matches the source's condition output.
    """

    __tablename__ = "flows"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(255))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", index=True)
    trigger_type: Mapped[str] = mapped_column(String(64))
    trigger_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    nodes: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    edges: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # Schedule trigger bookkeeping — populated by the worker tick when
    # this flow has trigger_type == "schedule". NULL until the first
    # tick fires.
    last_scheduled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Per-node captured sample outputs from the "Run this step" button.
    # Keyed by node_id. Used by the variable picker so downstream
    # steps see real keys (not just the action's static output_sample)
    # and by /run-node to thread real outputs through the template ctx.
    node_samples: Mapped[dict[str, Any]] = mapped_column(
        JSON, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
