"""
Datatypes voor de data-laag.
Pydantic geeft ons gratis validatie + auto-serialisatie naar JSON
(handig voor straks: dashboard + Supabase).
"""
from datetime import datetime
from pydantic import BaseModel


class Candle(BaseModel):
    """Eén OHLCV candle = open/high/low/close/volume voor een tijdsperiode."""
    pair: str               # bv. "BTC/EUR"
    timeframe: str          # bv. "15m"
    timestamp: datetime     # start van de candle (UTC)
    open: float
    high: float
    low: float
    close: float
    volume: float

    def __str__(self) -> str:  # leesbare logregel
        return f"{self.pair} {self.timeframe} {self.timestamp:%Y-%m-%d %H:%M} close={self.close:.2f}"
