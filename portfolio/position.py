"""
Position = een open long positie met bekende entry, size en stop loss.

Alleen LONG voor nu (we kopen, hopen op stijging, sluiten met winst of stop).
Short trading houdt deze bot bewust uit — complexer en niet wat de strategie zegt.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pydantic import BaseModel


class Position(BaseModel):
    pair: str
    entry_price: float
    size: float                 # hoeveelheid base asset (bv. BTC) gekocht
    stop_loss_price: float
    opened_at: datetime = None  # type: ignore[assignment]

    def model_post_init(self, _ctx) -> None:
        if self.opened_at is None:
            self.opened_at = datetime.now(timezone.utc)

    @property
    def entry_value(self) -> float:
        """EUR-waarde op moment van entry."""
        return self.size * self.entry_price

    def current_value(self, current_price: float) -> float:
        return self.size * current_price

    def unrealised_pnl(self, current_price: float) -> float:
        return self.current_value(current_price) - self.entry_value

    def is_stopped_out(self, current_price: float) -> bool:
        return current_price <= self.stop_loss_price
