"""CRUD for user-saved prompt templates.

Templates show up in the gemini_analyze_camera action's template
dropdown alongside the built-in security-camera presets. The
built-ins live in code (gemini_analyze_video.PROMPT_TEMPLATES) and
are merged with these DB rows by the frontend.
"""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.engine.actions.gemini_analyze_video import PROMPT_TEMPLATES
from app.models import PromptTemplate


router = APIRouter(prefix="/api/prompt-templates", tags=["prompt-templates"])


class PromptTemplateOut(BaseModel):
    id: UUID
    name: str
    value: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PromptTemplateCreate(BaseModel):
    name: str
    value: str


class PromptTemplateUpdate(BaseModel):
    name: str | None = None
    value: str | None = None


class BuiltinTemplate(BaseModel):
    name: str
    value: str


@router.get("/builtins", response_model=list[BuiltinTemplate])
async def list_builtin_templates() -> list[BuiltinTemplate]:
    """The hard-coded default prompts shipped with the gemini_analyze action.
    Shown on the Templates page as read-only starting points users can
    duplicate."""
    return [BuiltinTemplate(name=t["name"], value=t["value"]) for t in PROMPT_TEMPLATES]


@router.get("", response_model=list[PromptTemplateOut])
async def list_templates(
    session: AsyncSession = Depends(get_session),
) -> list[PromptTemplateOut]:
    rows = (
        await session.execute(
            select(PromptTemplate).order_by(PromptTemplate.name.asc())
        )
    ).scalars().all()
    return [PromptTemplateOut.model_validate(r) for r in rows]


@router.post("", response_model=PromptTemplateOut)
async def create_template(
    payload: PromptTemplateCreate,
    session: AsyncSession = Depends(get_session),
) -> PromptTemplateOut:
    if not payload.name.strip() or not payload.value.strip():
        raise HTTPException(status_code=400, detail="name and value are required")
    tpl = PromptTemplate(name=payload.name.strip(), value=payload.value)
    session.add(tpl)
    try:
        await session.commit()
    except IntegrityError:
        raise HTTPException(status_code=409, detail=f"name {payload.name!r} already exists")
    await session.refresh(tpl)
    return PromptTemplateOut.model_validate(tpl)


@router.put("/{tpl_id}", response_model=PromptTemplateOut)
async def update_template(
    tpl_id: UUID,
    payload: PromptTemplateUpdate,
    session: AsyncSession = Depends(get_session),
) -> PromptTemplateOut:
    tpl = await session.get(PromptTemplate, tpl_id)
    if tpl is None:
        raise HTTPException(status_code=404, detail="template not found")
    if payload.name is not None:
        if not payload.name.strip():
            raise HTTPException(status_code=400, detail="name cannot be empty")
        tpl.name = payload.name.strip()
    if payload.value is not None:
        if not payload.value.strip():
            raise HTTPException(status_code=400, detail="value cannot be empty")
        tpl.value = payload.value
    try:
        await session.commit()
    except IntegrityError:
        raise HTTPException(status_code=409, detail=f"name {payload.name!r} already exists")
    await session.refresh(tpl)
    return PromptTemplateOut.model_validate(tpl)


@router.delete("/{tpl_id}")
async def delete_template(
    tpl_id: UUID, session: AsyncSession = Depends(get_session)
) -> dict[str, bool]:
    tpl = await session.get(PromptTemplate, tpl_id)
    if tpl is None:
        raise HTTPException(status_code=404, detail="template not found")
    await session.delete(tpl)
    await session.commit()
    return {"ok": True}
