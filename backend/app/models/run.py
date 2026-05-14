from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, String, DateTime, Text, ForeignKey
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    # Runs survive flow deletion — the FK is SET NULL so historical runs
    # stay viewable as "(deleted flow)" rather than vanishing with the flow.
    flow_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("flows.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    webhook_event_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("webhook_events.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    input: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Per-step results: list of {name, type, status, output?, error?,
    # started_at?, finished_at?}. Empty for old runs that pre-date 3b.2.
    steps: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, server_default="[]")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
