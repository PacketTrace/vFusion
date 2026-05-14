from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class VerkadaHelixEventType(Base):
    """A Helix video-tagging event type already created in the user's Verkada
    org. We sync these so the action editor can offer a dropdown of real
    event_type_uids instead of asking the user to paste one in.
    """

    __tablename__ = "verkada_helix_event_types"
    __table_args__ = (
        UniqueConstraint(
            "connection_id", "event_type_uid", name="uq_helix_event_per_conn"
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    connection_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("connections.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    org_id: Mapped[str] = mapped_column(String(64), nullable=False)
    event_type_uid: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    event_schema: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    last_synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
