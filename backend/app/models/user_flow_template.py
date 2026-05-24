from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, String, Text, DateTime
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class UserFlowTemplate(Base):
    """User-created flow template.

    Mirrors the JSON-file shape used for built-in templates so a single
    list endpoint can merge both sources. Connection IDs inside the
    flow body are nulled out at save time — applying re-runs the
    standard auto-rebind helper, so a teammate importing the same
    template into a different deploy still picks up their own
    connection slots.
    """

    __tablename__ = "user_flow_templates"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(255))
    category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(String(255), nullable=True)
    default_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    flow: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
