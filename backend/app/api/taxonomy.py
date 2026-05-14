from fastapi import APIRouter

from app.connectors.verkada import TAXONOMY


router = APIRouter(prefix="/api/taxonomy", tags=["taxonomy"])


@router.get("/verkada")
async def verkada_taxonomy() -> dict:
    """Family → {label, webhook_type, notification_types, filter_fields}.

    The frontend uses this to render the trigger node's family/event-type
    picker without hardcoding strings.
    """
    return TAXONOMY
