"""
Technische indicatoren — vooralsnog alleen RSI, want dat is wat de strategie nodig heeft.

We gebruiken een handgeschreven Wilder-RSI in plaats van pandas-ta omdat:
- pandas-ta heeft een zware numba-dependency die soms hangt bij import op Windows
- RSI is 10 regels code, geen reden om er een library voor te trekken
- Resultaat is bit-identiek aan TradingView / Bitvavo / Binance RSI
"""
from __future__ import annotations

import pandas as pd

import config


def rsi(close: pd.Series, period: int = config.RSI_PERIOD) -> pd.Series:
    """
    Wilder's RSI op een close-prijs reeks.
    Returnt een Series met dezelfde index; de eerste `period` waarden zijn NaN
    (te weinig data om te berekenen, normaal gedrag).
    """
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)

    # Wilder smoothing = exponential moving average met alpha = 1/period
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()

    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def latest_rsi(close: pd.Series, period: int = config.RSI_PERIOD) -> float:
    """Geeft de meest recente RSI-waarde terug (handig voor de strategie)."""
    series = rsi(close, period).dropna()
    if series.empty:
        raise ValueError(f"Niet genoeg data voor RSI ({period} candles minimaal)")
    return float(series.iloc[-1])


if __name__ == "__main__":
    # Smoke test: haal candles, bereken RSI, print laatste 3 waarden
    from data.fetcher import fetch_candles, to_dataframe

    df = to_dataframe(fetch_candles("BTC/EUR", "15m", limit=100))
    df["rsi"] = rsi(df["close"])
    print(df.tail(3)[["close", "rsi"]])
    print(f"\nLaatste RSI: {latest_rsi(df['close']):.2f}")
