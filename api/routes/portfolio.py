from fastapi import APIRouter, HTTPException, Query

from api import db
from profiles import PROFILES, all_profiles

router = APIRouter(prefix="/api", tags=["portfolio"])


@router.get("/portfolio")
def get_portfolio_overview(profile: str = Query("gemiddeld", description="profile key")):
    """Snapshot history + latest van één profiel (voor Detail tab)."""
    if profile not in PROFILES:
        raise HTTPException(400, f"onbekend profiel: {profile}")
    history = db.latest_portfolio(limit=200, profile=profile)
    latest = history[0] if history else None
    realised = db.realised_pnl_total(profile)
    if latest is not None:
        latest = {**latest, "realised_pnl": realised}
    return {"profile": profile, "latest": latest, "history": history, "realised_pnl": realised}


@router.get("/portfolios")
def get_all_portfolios_overview():
    """
    Overview van alle 4 profielen — voor Vergelijking tab.
    Returnt per profiel: latest snapshot + tijdreeks + winrate.
    """
    out = []
    for p in all_profiles():
        history = db.latest_portfolio(limit=200, profile=p.key)
        latest = history[0] if history else None
        realised = db.realised_pnl_total(p.key)
        stats = db.trade_stats(p.key)
        if latest is not None:
            latest = {**latest, "realised_pnl": realised}
        out.append({
            "key":            p.key,
            "label":          p.label,
            "color":          p.color,
            "rsi_oversold":   p.rsi_oversold,
            "rsi_overbought": p.rsi_overbought,
            "trend_filter":   p.trend_filter,
            "max_positions":  p.max_positions,
            "risk_per_trade": p.risk_per_trade,
            "stop_loss_pct":  p.stop_loss_pct,
            "latest":         latest,
            "history":        history,
            "trades":         stats["total_trades"],
            "wins":           stats["wins"],
            "winrate":        stats["winrate"],
        })
    return {"profiles": out}
