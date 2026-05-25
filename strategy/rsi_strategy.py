"""
RSI-strategie, profile-aware.

Per profiel komen drempels uit het Profile object:
- BUY  als RSI_entry < profile.rsi_oversold EN (geen trend-filter OF RSI_trend < profile.trend_filter)
- SELL als RSI_entry > profile.rsi_overbought
- HOLD anders

`evaluate()` houdt verantwoordelijkheid voor data-fetch.
`evaluate_from_state()` accepteert vooraf-berekende marktdata zodat de bot
één keer per tick candles ophaalt en die voor alle 4 profielen hergebruikt.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Optional

import config
from data.fetcher import fetch_candles, to_dataframe
from data.indicators import latest_rsi
from profiles import Profile
from strategy.signal import Action, Signal


@dataclass(frozen=True)
class MarketState:
    """Snapshot van pair op tijdstip: prijs + beide RSI's. Eén keer berekend, hergebruikt over profielen."""
    pair: str
    price: float
    rsi_15m: float
    rsi_1h: float


def compute_market_state(pair: str) -> MarketState:
    df_entry = to_dataframe(fetch_candles(pair, config.TIMEFRAME_ENTRY, limit=200))
    df_trend = to_dataframe(fetch_candles(pair, config.TIMEFRAME_TREND, limit=200))
    if df_entry.empty or df_trend.empty:
        raise RuntimeError(f"Geen candle-data voor {pair}")
    return MarketState(
        pair=pair,
        price=float(df_entry["close"].iloc[-1]),
        rsi_15m=latest_rsi(df_entry["close"]),
        rsi_1h=latest_rsi(df_trend["close"]),
    )


def evaluate_from_state(
    state: MarketState,
    profile: Profile,
    regime: Optional[str] = None,
    regime_v3: Optional[str] = None,
) -> Signal:
    """
    Genereer signaal. Drie filtertypes:
    - V1 (use_200ma_filter): geregeld in OrderExecutor, hier geen actie
    - V2 (use_regime_filter): regime="bear"/"neutral"/"bull"
    - V3 (use_slope_filter):  regime_v3="bear-falling"/"bear-rising"/"above-close"/"above-far"

    Voor V2/V3 worden RSI-drempels per regime overschreven; voor "bull"/"above-far"
    wordt direct HOLD geretourneerd (pauze).
    """
    # V3 — slope-aware vier-state filter
    if profile.use_slope_filter and regime_v3 is not None:
        if regime_v3 == "above-far":
            return Signal(
                pair=state.pair, action=Action.HOLD,
                price=state.price, rsi_15m=state.rsi_15m, rsi_1h=state.rsi_1h,
                reason=f"[{profile.label}] BULL (>10% MA) — gepauzeerd",
            )
        thresholds = {
            "bear-falling": profile.regime_bear_falling,
            "bear-rising":  profile.regime_bear_rising,
            "above-close":  profile.regime_above_close,
        }.get(regime_v3)
        if thresholds is not None:
            os, ob = thresholds
            effective = replace(profile, rsi_oversold=os, rsi_overbought=ob)
            action, reason = _decide(state.rsi_15m, state.rsi_1h, effective)
            reason = f"[{profile.label}/{regime_v3}] {reason.split('] ', 1)[-1]}"
            return Signal(
                pair=state.pair, action=action,
                price=state.price, rsi_15m=state.rsi_15m, rsi_1h=state.rsi_1h, reason=reason,
            )

    # V2 — 3-state filter
    if profile.use_regime_filter and regime is not None:
        if regime == "bull":
            return Signal(
                pair=state.pair, action=Action.HOLD,
                price=state.price, rsi_15m=state.rsi_15m, rsi_1h=state.rsi_1h,
                reason=f"[{profile.label}] BULL regime — gepauzeerd",
            )
        thresholds = profile.regime_bear if regime == "bear" else profile.regime_neutral
        if thresholds is not None:
            os, ob = thresholds
            effective = replace(profile, rsi_oversold=os, rsi_overbought=ob)
            action, reason = _decide(state.rsi_15m, state.rsi_1h, effective)
            reason = f"[{profile.label}/{regime.upper()}] {reason.split('] ', 1)[-1]}"
            return Signal(
                pair=state.pair, action=action,
                price=state.price, rsi_15m=state.rsi_15m, rsi_1h=state.rsi_1h, reason=reason,
            )

    # Default — geen filter
    action, reason = _decide(state.rsi_15m, state.rsi_1h, profile)
    return Signal(
        pair=state.pair, action=action,
        price=state.price, rsi_15m=state.rsi_15m, rsi_1h=state.rsi_1h, reason=reason,
    )


def evaluate(pair: str, profile: Profile) -> Signal:
    """Convenience: fetch + decide. Voor losse calls (force_trade, debugging)."""
    return evaluate_from_state(compute_market_state(pair), profile)


def _decide(rsi_15m: float, rsi_1h: float, profile: Profile) -> tuple[Action, str]:
    trend_ok = profile.trend_filter is None or rsi_1h < profile.trend_filter
    if rsi_15m < profile.rsi_oversold and trend_ok:
        trend_part = "geen trend-filter" if profile.trend_filter is None else f"rsi1h<{profile.trend_filter}"
        return Action.BUY, f"[{profile.label}] oversold (rsi15m<{profile.rsi_oversold}) + {trend_part}"
    if rsi_15m > profile.rsi_overbought:
        return Action.SELL, f"[{profile.label}] overbought (rsi15m>{profile.rsi_overbought})"
    return Action.HOLD, f"[{profile.label}] geen entry/exit-conditie"


if __name__ == "__main__":
    from profiles import all_profiles
    for pair in config.PAIRS:
        state = compute_market_state(pair)
        print(f"\n{pair}  price={state.price:.2f}  rsi15m={state.rsi_15m:.1f}  rsi1h={state.rsi_1h:.1f}")
        for p in all_profiles():
            sig = evaluate_from_state(state, p)
            print(f"  {p.label:10s} → {sig.action.value:4s}  ({sig.reason})")
