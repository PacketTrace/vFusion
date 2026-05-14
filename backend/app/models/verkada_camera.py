from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, String, DateTime, Text, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class VerkadaCamera(Base):
    """Cached camera metadata pulled from the Verkada API.

    The mapping ``camera_id → name`` is the headline reason this exists —
    so the UI can render human-readable names where the underlying webhook
    only carried a UUID.
    """

    __tablename__ = "verkada_cameras"
    __table_args__ = (
        UniqueConstraint("connection_id", "camera_id", name="uq_verkada_cameras_conn_cam"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    connection_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("connections.id", ondelete="CASCADE"),
        index=True,
    )
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    serial: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
