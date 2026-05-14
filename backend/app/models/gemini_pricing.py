from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import DateTime, Integer, Numeric, String
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class GeminiPricing(Base):
    """Per-model Gemini token pricing. Refreshed by a daily cron from the
    hardcoded fallback in app/pricing/gemini.py — kept as a real DB row so
    UI queries can join on it and we can later swap in a live-scrape
    source without changing the read path."""

    __tablename__ = "gemini_pricing"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    model: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    input_per_1m_usd: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False)
    output_per_1m_usd: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False)
    input_per_1m_long_usd: Mapped[Decimal | None] = mapped_column(
        Numeric(10, 4), nullable=True
    )
    output_per_1m_long_usd: Mapped[Decimal | None] = mapped_column(
        Numeric(10, 4), nullable=True
    )
    long_threshold_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(255), nullable=False, default="hardcoded")
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
