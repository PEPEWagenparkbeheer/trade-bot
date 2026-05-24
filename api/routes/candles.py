from fastapi import APIRouter, HTTPException

import config
from data.fetcher import fetch_candles

router = APIRouter(prefix="/api/candles", tags=["candles"])


@router.get("")
def get_candles(pair: str = "BTC/EUR", timeframe: str = "15m", limit: int = 100):
    if pair not in config.PAIRS:
        raise HTTPException(400, f"pair {pair} niet geconfigureerd; gebruik {config.PAIRS}")
    candles = fetch_candles(pair, timeframe, limit=limit)
    return {
        "pair": pair,
        "timeframe": timeframe,
        "candles": [
            {
                "timestamp": c.timestamp.isoformat(),
                "open":  c.open,
                "high":  c.high,
                "low":   c.low,
                "close": c.close,
                "volume": c.volume,
            }
            for c in candles
        ],
    }
