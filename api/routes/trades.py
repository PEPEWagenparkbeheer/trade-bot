from fastapi import APIRouter

from api import db

router = APIRouter(prefix="/api/trades", tags=["trades"])


@router.get("")
def list_trades(limit: int = 50):
    return {"trades": db.latest_trades(limit=limit)}
