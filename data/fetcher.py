"""
Haalt candle-data op van Bitvavo via ccxt.
Public data — geen API-key nodig in paper-modus.

Bitvavo levert OHLCV (Open, High, Low, Close, Volume) per timeframe.
ccxt normaliseert dat naar een lijst van [timestamp_ms, o, h, l, c, v].
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List

import ccxt
import pandas as pd

import config
from data.models import Candle


# Eén ccxt client per proces volstaat — Bitvavo public endpoints hebben geen rate-limit drama
_exchange: ccxt.Exchange | None = None


def get_exchange() -> ccxt.Exchange:
    """
    Lazy-init de ccxt Bitvavo client.
    In paper-modus geen credentials nodig; in live-modus voegen we straks API key + secret toe.
    """
    global _exchange
    if _exchange is not None:
        return _exchange

    params: dict = {"enableRateLimit": True}
    if not config.is_paper():
        params["apiKey"] = config.BITVAVO_API_KEY
        params["secret"] = config.BITVAVO_SECRET

    _exchange = ccxt.bitvavo(params)
    return _exchange


def fetch_candles(pair: str, timeframe: str, limit: int = 200) -> List[Candle]:
    """
    Vraag de laatste `limit` candles op voor `pair` op `timeframe`.

    Voorbeelden:
        fetch_candles("BTC/EUR", "15m", 100)
        fetch_candles("ETH/EUR", "1h", 50)

    Returnt: lijst Candle objecten, oudste eerst, nieuwste laatst.
    """
    raw = get_exchange().fetch_ohlcv(pair, timeframe=timeframe, limit=limit)
    return [
        Candle(
            pair=pair,
            timeframe=timeframe,
            timestamp=datetime.fromtimestamp(ts / 1000, tz=timezone.utc),
            open=o, high=h, low=l, close=c, volume=v,
        )
        for ts, o, h, l, c, v in raw
    ]


def to_dataframe(candles: List[Candle]) -> pd.DataFrame:
    """
    Converteer Candle-lijst naar een pandas DataFrame met datetime-index.
    Pandas is de standaard voor RSI/indicatorberekening.
    """
    if not candles:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    df = pd.DataFrame(
        {
            "open":   [c.open   for c in candles],
            "high":   [c.high   for c in candles],
            "low":    [c.low    for c in candles],
            "close":  [c.close  for c in candles],
            "volume": [c.volume for c in candles],
        },
        index=pd.DatetimeIndex([c.timestamp for c in candles], name="timestamp"),
    )
    return df


if __name__ == "__main__":
    # Smoke test: haal de laatste 5 BTC/EUR 15m candles op
    candles = fetch_candles("BTC/EUR", "15m", limit=5)
    print(f"Opgehaald: {len(candles)} candles van Bitvavo (public, geen auth)")
    for c in candles:
        print(" ", c)
