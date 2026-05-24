from fastapi import APIRouter

from api import db

router = APIRouter(prefix="/api/signals", tags=["signals"])


@router.get("")
def list_signals(limit: int = 50):
    return {"signals": db.latest_signals(limit=limit)}
