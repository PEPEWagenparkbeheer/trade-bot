"""
Risicoprofielen — 4 vooraf gedefinieerde strategieën die parallel draaien.

Elk profiel heeft eigen RSI-drempels, trend-filter, position sizing en max
posities. De bot evalueert elke tick alle 4 met dezelfde marktdata en
slaat trades/signals/portfolios apart op (kolom `profile` in Supabase).

Belangrijke notes:
- `trend_filter=None` betekent: geen 1h trend-eis (alleen 15m RSI telt).
- `max_positions` is een totaal (over alle pairs), niet per pair.
- Met 2 pairs (BTC/EUR + ETH/EUR) is `max_positions >= 2` effectief
  hetzelfde als "max 1 per pair"; alleen Laag onderscheidt zich met 1 totaal.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Tuple


@dataclass(frozen=True)
class Profile:
    key: str            # database/url-key, kebab-snake (laag/gemiddeld/hoog/extreem/adaptief)
    label: str          # UI-label (Nederlands)
    color: str          # hex voor dashboard chart-lijnen
    rsi_oversold: float
    rsi_overbought: float
    trend_filter: Optional[float]  # None = geen 1h RSI trend-eis
    max_positions: int
    risk_per_trade: float          # fractie portfolio dat per trade gerisced wordt
    stop_loss_pct: float           # fractie onder entry waar stop ligt
    use_200ma_filter: bool = False # V1: True = pauzeer BUY's als BTC > 200MA * 1.03
    # V2 regime filter — strategie wijzigt drempels per marktregime:
    #   bear  (BTC <10% onder MA) → gebruik regime_bear drempels
    #   neutral (binnen ±10%)     → gebruik regime_neutral drempels
    #   bull  (>10% boven MA)     → pauzeer (geen BUY)
    use_regime_filter: bool = False
    regime_bear: Optional[Tuple[float, float]] = None     # (oversold, overbought)
    regime_neutral: Optional[Tuple[float, float]] = None
    # V3 slope-aware filter — vier regimes:
    #   bear-falling (BTC <MA + MA daalt)   → regime_bear_falling drempels
    #   bear-rising  (BTC <MA + MA stijgt)  → regime_bear_rising drempels
    #   above-close  (0..+10% MA)           → regime_above_close drempels
    #   above-far    (>+10% MA)             → pauzeer (geen BUY)
    use_slope_filter: bool = False
    regime_bear_falling: Optional[Tuple[float, float]] = None
    regime_bear_rising:  Optional[Tuple[float, float]] = None
    regime_above_close:  Optional[Tuple[float, float]] = None


PROFILES: Dict[str, Profile] = {
    "laag": Profile(
        key="laag", label="Laag", color="#22c55e",
        rsi_oversold=25, rsi_overbought=75,
        trend_filter=50,
        max_positions=1,
        risk_per_trade=0.01, stop_loss_pct=0.02,
    ),
    "hoog": Profile(
        key="hoog", label="Hoog", color="#f59e0b",
        rsi_oversold=35, rsi_overbought=65,
        trend_filter=60,
        max_positions=3,           # cap door 2 pairs effectief 2
        risk_per_trade=0.03, stop_loss_pct=0.04,
    ),
    "extreem": Profile(
        key="extreem", label="Extreem", color="#ef4444",
        rsi_oversold=40, rsi_overbought=60,
        trend_filter=None,         # geen trend-eis
        max_positions=4,           # cap door 2 pairs effectief 2
        risk_per_trade=0.05, stop_loss_pct=0.05,
    ),
    # Adaptief = strenge RSI 20/80 + 200MA markt-regime filter.
    # Pauzeert BUY-signalen wanneer BTC >3% boven 200-daags voortschrijdend
    # gemiddelde (bull market = pullback-risico). SELL en stop-loss werken
    # normaal door, zodat open posities altijd afgesloten kunnen worden.
    "adaptief": Profile(
        key="adaptief", label="Adaptief", color="#a855f7",
        rsi_oversold=20, rsi_overbought=80,
        trend_filter=None,
        max_positions=4,
        risk_per_trade=0.05, stop_loss_pct=0.05,
        use_200ma_filter=True,
    ),
    # Adaptief V2 = drie regimes ipv aan/uit.
    # Bear (BTC <-10% MA): agressief kopen op echte oversold (20/80)
    # Neutral (binnen ±10%): rustigere drempels (25/75)
    # Bull (>+10% MA): pauzeer nieuwe entries, bestaande SELL/stop blijven werken
    "adaptief2": Profile(
        key="adaptief2", label="Adaptief V2", color="#ec4899",
        rsi_oversold=20, rsi_overbought=80,   # default/fallback = bear drempels
        trend_filter=None,
        max_positions=4,
        risk_per_trade=0.05, stop_loss_pct=0.05,
        use_regime_filter=True,
        regime_bear=(20, 80),
        regime_neutral=(25, 75),
    ),
    # Adaptief V3 = V2 + slope-richting van de 200MA.
    # In bear-markt nuanceren: bij dalende MA volle kracht (oversold dips kopen),
    # bij stijgende MA voorzichtiger (herstel mogelijk, niet alles meer 20/80).
    # Boven MA binnen 10%: gematigd (28/72). >10% boven: pauze.
    "adaptief3": Profile(
        key="adaptief3", label="Adaptief V3", color="#06b6d4",
        rsi_oversold=20, rsi_overbought=80,   # fallback
        trend_filter=None,
        max_positions=4,
        risk_per_trade=0.05, stop_loss_pct=0.05,
        use_slope_filter=True,
        regime_bear_falling=(20, 80),
        regime_bear_rising=(25, 75),
        regime_above_close=(28, 72),
    ),
}


def get_profile(key: str) -> Profile:
    if key not in PROFILES:
        raise ValueError(f"Onbekend profiel: {key!r}. Beschikbaar: {list(PROFILES)}")
    return PROFILES[key]


def all_profiles() -> list[Profile]:
    return list(PROFILES.values())
