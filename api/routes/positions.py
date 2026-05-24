"""Open posities per profiel — voor Detail tab."""
from fastapi import APIRouter, Query

from api import db
from data.fetcher import fetch_candles

router = APIRouter(prefix="/api", tags=["positions"])


def _current_price(pair: str) -> float | None:
    try:
        candles = fetch_candles(pair, "15m", limit=1)
        return float(candles[-1].close) if candles else None
    except Exception:
        return None


@router.get("/positions")
def get_open_positions(profile: str | None = Query(None)):
    raw = db.list_open_positions(profile=profile)
    out = []
    for r in raw:
        pair = r["pair"]
        entry = float(r["entry_price"])
        size = float(r["size"])
        stop = float(r["stop_loss_price"])
        current = _current_price(pair) or entry
        market_value = size * current
        entry_value = size * entry
        pnl = market_value - entry_value
        pnl_pct = (current - entry) / entry
        out.append({
            "profile":            r["profile"],
            "pair":               pair,
            "entry_price":        entry,
            "size":               size,
            "stop_loss_price":    stop,
            "current_price":      current,
            "market_value":       market_value,
            "unrealised_pnl":     pnl,
            "unrealised_pnl_pct": pnl_pct,
            "opened_at":          r["opened_at"],
        })
    return {"positions": out}
