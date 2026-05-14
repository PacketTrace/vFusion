"""Live progress reporter for actions.

The worker constructs a :class:`StepProgress` bound to a (run_id, step_name)
and stuffs it into the template context as ``ctx["_progress"]``. Actions
that want to emit phase/log events call:

    progress = ctx.get("_progress")
    if progress:
        await progress.phase("ffmpeg_grab", "running", "starting clip pull")

Each call writes one row to ``run_events`` so the frontend (polling
``/api/runs/{id}/events``) can render the checklist + log stream live.

The reporter swallows DB errors — losing a log line should never break
a running action. Each emit opens its own short-lived AsyncSession so it
doesn't share state with whatever the worker is doing.
"""

from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from app.db import SessionLocal
from app.models import RunEvent


logger = logging.getLogger(__name__)


class StepProgress:
    def __init__(self, run_id: UUID, step_name: str) -> None:
        self.run_id = run_id
        self.step_name = step_name

    async def _write(
        self,
        phase: Optional[str],
        status: Optional[str],
        message: Optional[str],
    ) -> None:
        try:
            async with SessionLocal() as session:
                session.add(
                    RunEvent(
                        run_id=self.run_id,
                        step_name=self.step_name,
                        phase=phase,
                        status=status,
                        message=message,
                    )
                )
                await session.commit()
        except Exception:  # noqa: BLE001 — never break the action over a log line
            logger.exception("run_events insert failed")

    async def phase(
        self,
        phase: str,
        status: str,
        message: Optional[str] = None,
    ) -> None:
        """Transition a known phase to running/success/failed."""
        await self._write(phase=phase, status=status, message=message)

    async def log(self, message: str) -> None:
        """Free-form log line for the nerd panel."""
        await self._write(phase=None, status=None, message=message)
