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
from typing import Dict, Optional


@dataclass(frozen=True)
class Profile:
    key: str            # database/url-key, kebab-snake (laag/gemiddeld/hoog/extreem)
    label: str          # UI-label (Nederlands)
    color: str          # hex voor dashboard chart-lijnen
    rsi_oversold: float
    rsi_overbought: float
    trend_filter: Optional[float]  # None = geen 1h trend-eis
    max_positions: int
    risk_per_trade: float          # fractie portfolio dat per trade gerisced wordt
    stop_loss_pct: float           # fractie onder entry waar stop ligt


PROFILES: Dict[str, Profile] = {
    "laag": Profile(
        key="laag", label="Laag", color="#22c55e",
        rsi_oversold=25, rsi_overbought=75,
        trend_filter=50,
        max_positions=1,
        risk_per_trade=0.01, stop_loss_pct=0.02,
    ),
    "gemiddeld": Profile(
        key="gemiddeld", label="Gemiddeld", color="#3b82f6",
        rsi_oversold=30, rsi_overbought=70,
        trend_filter=55,
        max_positions=2,
        risk_per_trade=0.02, stop_loss_pct=0.03,
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
}


def get_profile(key: str) -> Profile:
    if key not in PROFILES:
        raise ValueError(f"Onbekend profiel: {key!r}. Beschikbaar: {list(PROFILES)}")
    return PROFILES[key]


def all_profiles() -> list[Profile]:
    return list(PROFILES.values())
