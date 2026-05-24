from fastapi import APIRouter, Query

from api import db

router = APIRouter(prefix="/api", tags=["trades"])


@router.get("/trades")
def list_trades(limit: int = 50, profile: str | None = Query(None)):
    return {"trades": db.latest_trades(limit=limit, profile=profile)}
