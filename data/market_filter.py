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
    is_bull: bool          # price > ma * (1 + buffer)   — V1 filter (3% buffer)
    regime: str            # "bear" | "neutral" | "bull" — V2 filter (10% drempels)
    slope: float           # ma_today - ma_10d_geleden (EUR) → positief = stijgend
    slope_pct: float       # slope / ma_today
    regime_v3: str         # "bear-falling" | "bear-rising" | "above-close" | "above-far"


def get_200ma_btc(pair: str = "BTC/EUR") -> tuple[float, float, float]:
    """
    Returnt (current_price, 200ma_today, 200ma_10d_ago) — laatste waarde nodig
    voor slope-berekening (V3 filter). Fetcht 210 daily candles in 1 call.
    """
    candles = fetch_candles(pair, "1d", limit=210)
    if not candles:
        raise RuntimeError(f"Geen daily candles voor {pair}")
    closes = [c.close for c in candles]
    ma_today = sum(closes[-200:]) / min(200, len(closes))
    # 10-day-lag MA: pak 200 candles eindigend 10 dagen geleden
    ma_10d_ago = (
        sum(closes[-210:-10]) / 200
        if len(closes) >= 210 else ma_today  # geen slope mogelijk
    )
    current = closes[-1]
    return current, ma_today, ma_10d_ago


def get_200ma_slope(pair: str = "BTC/EUR") -> float:
    """V3 shortcut: positief = stijgende MA, negatief = dalende MA."""
    _, ma_today, ma_10d_ago = get_200ma_btc(pair)
    return ma_today - ma_10d_ago


REGIME_THRESHOLD = 0.10   # ±10% rond 200MA bepaalt bear/neutral/bull (V2 filter)


def _classify_v2(distance_pct: float) -> str:
    if distance_pct > REGIME_THRESHOLD:
        return "bull"
    if distance_pct < -REGIME_THRESHOLD:
        return "bear"
    return "neutral"


def _classify_v3(distance_pct: float, slope: float) -> str:
    """
    Adaptief V3 regime:
    - boven 200MA met >10% buffer → 'above-far'   (pauze)
    - boven 200MA, binnen 10%     → 'above-close' (28/72, beperkt)
    - onder 200MA + MA daalt      → 'bear-falling' (20/80, volle kracht)
    - onder 200MA + MA stijgt     → 'bear-rising' (25/75, herstel mogelijk)
    """
    if distance_pct > REGIME_THRESHOLD: return "above-far"
    if distance_pct >= 0:                return "above-close"
    return "bear-falling" if slope < 0 else "bear-rising"


def market_regime(pair: str = "BTC/EUR", buffer: float = 0.03) -> MarketRegime:
    """
    Cache-aware lookup. Returns MarketRegime met:
    - current price + 200MA + relatieve afstand
    - is_bull (V1, 3% buffer)
    - regime "bear"/"neutral"/"bull" (V2, 10% drempels)
    - slope + regime_v3 (V3, slope-aware classificatie)
    """
    now = time.time()
    if _cache["data"] is not None and (now - _cache["ts"]) < _CACHE_TTL_SECONDS:
        return _cache["data"]

    current, ma, ma_10d_ago = get_200ma_btc(pair)
    distance = (current - ma) / ma if ma > 0 else 0.0
    slope = ma - ma_10d_ago
    slope_pct = slope / ma if ma > 0 else 0.0
    mr = MarketRegime(
        btc_price=current,
        ma_200=ma,
        distance_pct=distance,
        is_bull=distance > buffer,
        regime=_classify_v2(distance),
        slope=slope,
        slope_pct=slope_pct,
        regime_v3=_classify_v3(distance, slope),
    )
    _cache["ts"] = now
    _cache["data"] = mr
    return mr


def is_bull_market(buffer: float = 0.03) -> bool:
    """V1 shortcut: True als BTC > 200MA * (1 + buffer)."""
    return market_regime(buffer=buffer).is_bull


def get_market_regime(pair: str = "BTC/EUR") -> str:
    """V2 shortcut: 'bear' | 'neutral' | 'bull' op basis van ±10% rond 200MA."""
    return market_regime(pair).regime


def get_market_regime_v3(pair: str = "BTC/EUR") -> str:
    """V3 shortcut: 4-state op basis van afstand én slope."""
    return market_regime(pair).regime_v3


if __name__ == "__main__":
    r = market_regime()
    print(f"BTC: EUR {r.btc_price:,.2f}")
    print(f"200MA: EUR {r.ma_200:,.2f}")
    print(f"Afstand: {r.distance_pct*100:+.2f}%")
    print(f"Slope (10d):     EUR {r.slope:+,.2f}  ({r.slope_pct*100:+.2f}%)")
    print(f"V1 (Adaptief, 3% buffer):     {'BULL — pauzeer' if r.is_bull else 'NORMAAL — handel'}")
    print(f"V2 (Adaptief V2, ±10%):       {r.regime.upper()}")
    print(f"V3 (Adaptief V3, slope-aware): {r.regime_v3.upper()}")
