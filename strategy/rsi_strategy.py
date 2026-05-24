"""
RSI-strategie volgens CLAUDE.md:

  LONG  : RSI 15m < 30  EN  RSI 1h < 50
  EXIT  : RSI 15m > 70  (of stop loss — die wordt door portfolio afgehandeld)
  HOLD  : alles daartussen

Deze module produceert alleen het Signal — opening/sluiting van posities
gebeurt in de engine + portfolio.
"""
from __future__ import annotations

import config
from data.fetcher import fetch_candles, to_dataframe
from data.indicators import latest_rsi
from strategy.signal import Action, Signal


def evaluate(pair: str) -> Signal:
    """
    Haal de laatste candles op voor `pair`, bereken RSI op beide timeframes,
    en zet om in een Signal. Eén call per pair per tick.
    """
    # 15m candles — entry timeframe
    df_entry = to_dataframe(
        fetch_candles(pair, config.TIMEFRAME_ENTRY, limit=200)
    )
    # 1h candles — trendfilter
    df_trend = to_dataframe(
        fetch_candles(pair, config.TIMEFRAME_TREND, limit=200)
    )

    if df_entry.empty or df_trend.empty:
        raise RuntimeError(f"Geen candle-data voor {pair}")

    rsi_15m = latest_rsi(df_entry["close"])
    rsi_1h = latest_rsi(df_trend["close"])
    price = float(df_entry["close"].iloc[-1])

    action, reason = _decide(rsi_15m, rsi_1h)

    return Signal(
        pair=pair,
        action=action,
        price=price,
        rsi_15m=rsi_15m,
        rsi_1h=rsi_1h,
        reason=reason,
    )


def _decide(rsi_15m: float, rsi_1h: float) -> tuple[Action, str]:
    """Pure beslissingslogica — los van data-fetching, makkelijk te unit-testen."""
    if rsi_15m < config.RSI_OVERSOLD and rsi_1h < config.RSI_TREND_FILTER:
        return Action.BUY, f"oversold (rsi15m<{config.RSI_OVERSOLD}) + zwakke trend (rsi1h<{config.RSI_TREND_FILTER})"
    if rsi_15m > config.RSI_OVERBOUGHT:
        return Action.SELL, f"overbought (rsi15m>{config.RSI_OVERBOUGHT})"
    return Action.HOLD, "geen entry- of exit-conditie"


if __name__ == "__main__":
    # Smoke test: print signaal voor elke geconfigureerde pair
    for pair in config.PAIRS:
        signal = evaluate(pair)
        print(signal)
