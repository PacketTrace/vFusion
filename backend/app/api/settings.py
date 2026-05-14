"""Settings API — UI-editable runtime knobs (retention, etc.)."""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.footage import CLIP_ROOT, IMAGE_ROOT
from app.db import get_session
from app.models import Run, WebhookAsset, WebhookEvent
from app.settings_store import (
    SETTINGS,
    all_specs,
    get_str,
    set_value,
)


router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingUsage(BaseModel):
    """Current footprint of whatever this setting governs.

    ``bytes`` is the on-disk / row-content size estimate; ``count`` is the
    item count (rows, files). Either or both may be null if the metric
    isn't applicable. ``summary`` is a pre-formatted human string the UI
    can drop in as-is — keeps the formatting policy server-side.
    """

    bytes: int | None = None
    count: int | None = None
    summary: str


class SettingRow(BaseModel):
    key: str
    label: str
    unit: str
    description: str
    default: str
    allow_zero: bool
    value: str | None  # the *effective* value (stored OR default if unset)
    usage: SettingUsage | None = None


class SettingsResponse(BaseModel):
    items: list[SettingRow]


def _fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    return f"{n / 1024 / 1024 / 1024:.2f} GB"


def _fmt_count(n: int, noun: str) -> str:
    s = "" if n == 1 else "s"
    return f"{n:,} {noun}{s}"


def _dir_size(path: Path) -> tuple[int, int]:
    if not path.exists():
        return (0, 0)
    total = 0
    count = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
                count += 1
        except OSError:
            continue
    return (total, count)


async def _usage_for(key: str, session: AsyncSession) -> SettingUsage:
    """Compute current footprint per retention bucket."""
    if key == "webhook_event_retention_days":
        # Body size is stored on the row, so SUM is cheap. Counts also.
        row = (
            await session.execute(
                select(
                    func.count(WebhookEvent.id),
                    func.coalesce(func.sum(WebhookEvent.body_size), 0),
                )
            )
        ).one()
        n, b = int(row[0]), int(row[1])
        return SettingUsage(
            bytes=b,
            count=n,
            summary=f"{_fmt_count(n, 'event')} · ~{_fmt_bytes(b)} of bodies",
        )
    if key == "webhook_asset_retention_days":
        row = (
            await session.execute(
                select(
                    func.count(WebhookAsset.id),
                    func.coalesce(func.sum(WebhookAsset.file_size), 0),
                ).where(WebhookAsset.status == "ready")
            )
        ).one()
        n, b = int(row[0]), int(row[1])
        return SettingUsage(
            bytes=b,
            count=n,
            summary=f"{_fmt_count(n, 'file')} · {_fmt_bytes(b)}",
        )
    if key == "gemini_clip_retention_days":
        b, n = _dir_size(Path(CLIP_ROOT))
        return SettingUsage(
            bytes=b,
            count=n,
            summary=f"{_fmt_count(n, 'clip')} · {_fmt_bytes(b)}",
        )
    if key == "gemini_image_retention_days":
        b, n = _dir_size(Path(IMAGE_ROOT))
        return SettingUsage(
            bytes=b,
            count=n,
            summary=f"{_fmt_count(n, 'image')} · {_fmt_bytes(b)}",
        )
    if key == "run_retention_days":
        n = int(
            (await session.execute(select(func.count(Run.id)))).scalar() or 0
        )
        return SettingUsage(
            bytes=None,
            count=n,
            summary=_fmt_count(n, "run"),
        )
    return SettingUsage(summary="—")


class SettingUpdate(BaseModel):
    value: str | None  # None or "" clears the override and reverts to default


@router.get("", response_model=SettingsResponse)
async def list_settings(
    session: AsyncSession = Depends(get_session),
) -> SettingsResponse:
    items: list[SettingRow] = []
    for spec in all_specs():
        value = await get_str(spec["key"])
        usage = await _usage_for(spec["key"], session)
        items.append(
            SettingRow(
                key=spec["key"],
                label=spec["label"],
                unit=spec["unit"],
                description=spec["description"],
                default=spec["default"],
                allow_zero=spec["allow_zero"],
                value=value,
                usage=usage,
            )
        )
    return SettingsResponse(items=items)


@router.put("/{key}", response_model=SettingRow)
async def update_setting(
    key: str,
    body: SettingUpdate,
    session: AsyncSession = Depends(get_session),
) -> SettingRow:
    spec = SETTINGS.get(key)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown setting key: {key!r}")

    # Validate the value if non-empty — must parse as a non-negative int.
    value = body.value
    if value is not None and value != "":
        try:
            n = int(value)
        except ValueError as e:
            raise HTTPException(
                status_code=400, detail=f"value must be an integer: {e}"
            ) from e
        if n < 0:
            raise HTTPException(status_code=400, detail="value must be >= 0")
        if n == 0 and not spec.allow_zero:
            raise HTTPException(
                status_code=400,
                detail=f"setting {key!r} doesn't allow 0",
            )
    else:
        # Empty string = reset to default — store NULL.
        value = None

    await set_value(session, key, value)
    await session.commit()
    effective = await get_str(key)
    return SettingRow(
        key=spec.key,
        label=spec.label,
        unit=spec.unit,
        description=spec.description,
        default=spec.default,
        allow_zero=spec.allow_zero,
        value=effective,
    )
