from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import JSON, String, Text, DateTime, Integer
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class WebhookEvent(Base):
    __tablename__ = "webhook_events"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    slug: Mapped[str] = mapped_column(String(255), index=True)
    method: Mapped[str] = mapped_column(String(10))
    path: Mapped[str] = mapped_column(String(1024))
    query_string: Mapped[str] = mapped_column(String(2048), default="")
    headers: Mapped[dict] = mapped_column(JSON, default=dict)
    body_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    body_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_size: Mapped[int] = mapped_column(Integer, default=0)
    remote_addr: Mapped[str | None] = mapped_column(String(64), nullable=True)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    # Phase 2: classification + signature verification, populated at ingest.
    family: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    notification_type: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    webhook_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    org_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    signature_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
