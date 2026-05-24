"""
Signal = wat de strategie tegen de engine zegt.
HOLD doet niets, BUY opent een long, SELL sluit een open long.

Een signaal is data, niet actie. De engine beslist of het wordt uitgevoerd
(bv. nog geen open positie? dan kan SELL niet gebruikt worden).
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from pydantic import BaseModel


class Action(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"


class Signal(BaseModel):
    pair: str               # bv. "BTC/EUR"
    action: Action
    price: float            # close van de meest recente candle (referentieprijs)
    rsi_15m: float
    rsi_1h: float
    reason: str             # menselijke uitleg, gaat naar logger + dashboard
    created_at: datetime = None  # type: ignore[assignment]

    def model_post_init(self, _ctx) -> None:
        if self.created_at is None:
            self.created_at = datetime.now(timezone.utc)

    def __str__(self) -> str:
        return (
            f"[{self.created_at:%H:%M:%S}] {self.pair} {self.action.value} "
            f"@ {self.price:.2f}  rsi15m={self.rsi_15m:.1f} rsi1h={self.rsi_1h:.1f}  ({self.reason})"
        )
