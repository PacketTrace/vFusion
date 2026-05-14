from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, String, DateTime, Text, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class VerkadaApiSpec(Base):
    """One row per Verkada API namespace (camera_v1, access_v1, etc.).

    Cache of the upstream OpenAPI document plus fetch metadata.
    """

    __tablename__ = "verkada_api_specs"
    __table_args__ = (UniqueConstraint("namespace", name="uq_verkada_api_specs_namespace"),)

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    namespace: Mapped[str] = mapped_column(String(64))
    url: Mapped[str] = mapped_column(String(512))
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    api_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    openapi_version: Mapped[str | None] = mapped_column(String(16), nullable=True)
    raw_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    fetch_status: Mapped[str] = mapped_column(String(32), default="pending", server_default="pending")
    fetch_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class VerkadaApiEndpoint(Base):
    """One row per (spec, method, path) — operation-level change tracking."""

    __tablename__ = "verkada_api_endpoints"
    __table_args__ = (
        UniqueConstraint(
            "spec_id", "method", "path", name="uq_verkada_api_endpoints_spec_method_path"
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    spec_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("verkada_api_specs.id", ondelete="CASCADE"),
        index=True,
    )
    namespace: Mapped[str] = mapped_column(String(64), index=True)
    method: Mapped[str] = mapped_column(String(8))
    path: Mapped[str] = mapped_column(String(512))
    operation_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    summary: Mapped[str | None] = mapped_column(String(512), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    raw: Mapped[dict[str, Any]] = mapped_column(JSON)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
