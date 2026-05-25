"""
Marktfilter voor profielen die alleen willen handelen in bepaalde regimes.

Implementeert de **200-daags voortschrijdend gemiddelde** filter:
- Berekent gemiddelde slotkoers van laatste 200 dagelijkse BTC/EUR candles
- 'Bull market' = huidige BTC prijs > 200MA * (1 + buffer)
- Buffer voorkomt aan/uit-schakelen rond de 200MA (default 3%)

Wordt gebruikt door het Adaptief-profiel: pauzeert BUY-signalen tijdens bull market,
zodat alleen op dips/correcties wordt ingestapt.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from data.fetcher import fetch_candles


# Cache: 200MA verandert pas bij een nieuwe daily candle (~1x per dag).
# 1 uur TTL is ruim genoeg en bespaart Bitvavo calls bij elke tick × profielen.
_CACHE_TTL_SECONDS = 3600
_cache: dict = {"ts": 0.0, "data": None}


@dataclass(frozen=True)
class MarketRegime:
    btc_price: float
    ma_200: float
    distance_pct: float    # (price - ma) / ma  → positief = boven MA
    is_bull: bool          # price > ma * (1 + buffer)


def get_200ma_btc(pair: str = "BTC/EUR") -> tuple[float, float]:
    """
    Returnt (current_price, 200ma) op basis van de laatste 200 dagelijkse candles.
    Bitvavo levert max 1440 candles per call — 200 past ruim in 1 call.
    """
    candles = fetch_candles(pair, "1d", limit=200)
    if len(candles) < 200:
        # Niet genoeg historie — pair bestaat korter dan 200 dagen.
        # Gebruik wat we hebben, val terug op gem. van beschikbare data.
        if not candles:
            raise RuntimeError(f"Geen daily candles voor {pair}")
    closes = [c.close for c in candles]
    ma = sum(closes) / len(closes)
    current = closes[-1]   # laatste candle = meest recente dag (gesloten)
    return current, ma


def market_regime(pair: str = "BTC/EUR", buffer: float = 0.03) -> MarketRegime:
    """
    Cache-aware lookup. Returns MarketRegime met current price, 200MA en bull-flag.
    """
    now = time.time()
    if _cache["data"] is not None and (now - _cache["ts"]) < _CACHE_TTL_SECONDS:
        return _cache["data"]

    current, ma = get_200ma_btc(pair)
    distance = (current - ma) / ma if ma > 0 else 0.0
    regime = MarketRegime(
        btc_price=current,
        ma_200=ma,
        distance_pct=distance,
        is_bull=distance > buffer,
    )
    _cache["ts"] = now
    _cache["data"] = regime
    return regime


def is_bull_market(buffer: float = 0.03) -> bool:
    """Shortcut: True als BTC > 200MA * (1 + buffer)."""
    return market_regime(buffer=buffer).is_bull


if __name__ == "__main__":
    r = market_regime()
    state = "BULL (pauzeer)" if r.is_bull else "NORMAAL (handel)"
    print(f"BTC: EUR {r.btc_price:,.2f}")
    print(f"200MA: EUR {r.ma_200:,.2f}")
    print(f"Afstand: {r.distance_pct*100:+.2f}%")
    print(f"Regime: {state}")
