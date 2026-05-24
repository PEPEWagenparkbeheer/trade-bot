from fastapi import APIRouter

from api import db

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


@router.get("")
def get_portfolio_overview():
    """
    Laatste snapshot + tijdreeks voor het dashboard.
    realised_pnl wordt live overschreven uit bot_trades — single source of truth,
    zodat KPI's altijd matchen met de trades-lijst, ook na force_trades.
    """
    history = db.latest_portfolio(limit=200)
    latest = history[0] if history else None
    realised = db.realised_pnl_total()
    if latest is not None:
        latest = {**latest, "realised_pnl": realised}
    return {"latest": latest, "history": history, "realised_pnl": realised}
