from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class AuditEvent(Base):
    """One row of the Verkada Command audit log, as vFusion pulled it.

    Verkada's ``GET /core/v1/audit_log`` takes a time range and nothing
    else -- no event, user, device or IP filter -- so every question the
    Explorer answers is answered against this table, not the API. The
    columns that are lifted out of the raw entry are the ones a filter or
    a chart groups by; everything else stays in ``details`` / ``devices``
    / ``raw`` so nothing the API said is lost.

    Verkada publishes no event id. ``fingerprint`` is a hash over the
    fields that make an entry itself, which lets the poller re-read an
    overlapping window (deliberately -- see ``app.audit.ingest``) and
    insert nothing twice.
    """

    __tablename__ = "audit_events"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    fingerprint: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    connection_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    org_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    event_name: Mapped[str] = mapped_column(String(128), nullable=False)
    event_description: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # Verkada's own Audit Log page groups events into categories
    # (Admin, User Management, Cameras, ...). ``category`` is that
    # grouping, derived at ingest from ``app.audit.taxonomy`` so the
    # Explorer's filters line up with what an operator already knows.
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    # user | api_key | support | system
    actor: Mapped[str] = mapped_column(String(16), nullable=False)

    user_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Public API Request fields. Null for everything else.
    api_key_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    api_key_tail: Mapped[str | None] = mapped_column(String(16), nullable=True)
    method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    url_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # True when the request was made with a key vFusion itself holds.
    # This is most of a working org's log, and hidden by default.
    is_self: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # First device on the entry, lifted for filtering. The full list is
    # in ``devices``.
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    device_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    device_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    device_site: Mapped[str | None] = mapped_column(String(255), nullable=True)
    device_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    devices: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    details: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    raw: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Everything a substring search should hit, lower-cased and joined,
    # so ``q`` is one ILIKE over one column instead of ten.
    search_text: Mapped[str] = mapped_column(Text, nullable=False, default="")

    __table_args__ = (
        Index("ix_audit_events_timestamp", "timestamp"),
        Index("ix_audit_events_processed_at", "processed_at"),
        Index("ix_audit_events_event_name_ts", "event_name", "timestamp"),
        Index("ix_audit_events_category_ts", "category", "timestamp"),
        Index("ix_audit_events_user_email_ts", "user_email", "timestamp"),
        Index("ix_audit_events_ip_ts", "ip_address", "timestamp"),
        Index("ix_audit_events_api_key_ts", "api_key_name", "timestamp"),
        Index("ix_audit_events_device_id_ts", "device_id", "timestamp"),
        Index("ix_audit_events_self_ts", "is_self", "timestamp"),
    )
