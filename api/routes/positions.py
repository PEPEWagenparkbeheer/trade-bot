"""Open posities endpoint — wat de bot momenteel aan open longs heeft staan."""
from fastapi import APIRouter

from api import db
from data.fetcher import fetch_candles

router = APIRouter(prefix="/api/positions", tags=["positions"])


def _current_price(pair: str) -> float | None:
    try:
        candles = fetch_candles(pair, "15m", limit=1)
        return float(candles[-1].close) if candles else None
    except Exception:
        return None


@router.get("")
def get_open_positions():
    raw = db.list_open_positions()
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
            "pair": pair,
            "entry_price": entry,
            "size": size,
            "stop_loss_price": stop,
            "current_price": current,
            "market_value": market_value,
            "unrealised_pnl": pnl,
            "unrealised_pnl_pct": pnl_pct,
            "opened_at": r["opened_at"],
        })
    return {"positions": out}
