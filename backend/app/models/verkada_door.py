from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, String, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class VerkadaDoor(Base):
    """Cached door metadata pulled from /access/v1/door.

    Mirrors the VerkadaCamera pattern so the UI can offer door pickers
    that show ``Front Door — HQ`` instead of bare UUIDs.
    """

    __tablename__ = "verkada_doors"
    __table_args__ = (
        UniqueConstraint("connection_id", "door_id", name="uq_verkada_doors_conn_door"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    connection_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("connections.id", ondelete="CASCADE"),
        index=True,
    )
    door_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    acu_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    acu_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
