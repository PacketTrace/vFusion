from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class RunEvent(Base):
    """One line of live progress emitted while a Run is executing.

    Two kinds of rows coexist here:
      - Phase transitions: ``phase`` + ``status`` (running|success|failed),
        used by the UI's per-step checklist.
      - Log lines: ``message`` only, dumped into the "nerd panel" for
        whoever wants to see ffmpeg stderr or sub-second timings.

    A row may carry both — e.g. a "ffmpeg_grab succeeded in 7.3s" entry
    sets both phase/status AND a message.
    """

    __tablename__ = "run_events"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    step_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phase: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
