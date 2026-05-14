from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import String, DateTime, Text, Integer, ForeignKey
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class WebhookAsset(Base):
    """Locally-cached media (image / gif / video poster) fetched from a
    webhook's body. Verkada's URLs carry short-lived signed tokens so
    we grab the bytes the moment the webhook lands.

    ``expires_at`` lets the hourly cleanup cron drop anything older
    than the retention window (default 24h).
    """

    __tablename__ = "webhook_assets"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    webhook_event_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("webhook_events.id", ondelete="CASCADE"),
        index=True,
    )
    source_url: Mapped[str] = mapped_column(Text)
    source_field: Mapped[str] = mapped_column(String(128))
    local_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), index=True
    )
