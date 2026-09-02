from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import Boolean, DateTime, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class McpToolObservation(Base):
    """When we first saw a given tool on a given MCP server.

    MCP has no notion of "when was this added" — ``tools/list`` returns
    name, description, inputSchema and annotations, nothing temporal. The
    only way to answer the question is to keep looking and write down what
    changed, which is what this table is.

    ``is_baseline`` marks the tools that existed the first time we ever
    looked at a server. Their real add date is unknowable, so the UI shows
    them as "original" instead of inventing one.
    """

    __tablename__ = "mcp_tool_observations"
    __table_args__ = (
        UniqueConstraint("server_url", "tool_name", name="uq_mcp_tool_obs"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    server_url: Mapped[str] = mapped_column(String(512), index=True)
    tool_name: Mapped[str] = mapped_column(String(255))
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    is_baseline: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    schema_hash: Mapped[str] = mapped_column(String(64))
    schema_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    removed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
