from fastapi import APIRouter, Query

from api import db

router = APIRouter(prefix="/api", tags=["signals"])


@router.get("/signals")
def list_signals(limit: int = 50, profile: str | None = Query(None)):
    return {"signals": db.latest_signals(limit=limit, profile=profile)}
