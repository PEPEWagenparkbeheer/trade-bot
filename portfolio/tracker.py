"""
PortfolioTracker = read-only snapshots over een PortfolioManager.

Splitst de "wat gebeurt er" (manager) van de "hoe ziet het eruit" (tracker)
zodat het dashboard straks via tracker-snapshots werkt zonder de manager state
te kunnen vervuilen.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List

from pydantic import BaseModel

from portfolio.manager import PortfolioManager


class PositionSnapshot(BaseModel):
    pair: str
    entry_price: float
    size: float
    current_price: float
    market_value: float
    unrealised_pnl: float
    stop_loss_price: float


class PortfolioSnapshot(BaseModel):
    timestamp: datetime
    capital: float                # cash op de bank
    market_value: float           # gemarkt-naar-marktwaarde van open posities
    total_value: float            # capital + market_value
    realised_pnl: float           # gerealiseerd over alle gesloten trades
    open_positions: List[PositionSnapshot]
    total_trades: int


class PortfolioTracker:
    def __init__(self, manager: PortfolioManager) -> None:
        self.manager = manager

    def snapshot(self, prices: Dict[str, float]) -> PortfolioSnapshot:
        """
        Maak een snapshot tegen de gegeven mark-prijzen.
        `prices` is een dict {pair: current_price}.
        """
        open_snaps: List[PositionSnapshot] = []
        market_value = 0.0
        for pair, pos in self.manager.open_positions.items():
            mark = prices.get(pair, pos.entry_price)
            value = pos.current_value(mark)
            market_value += value
            open_snaps.append(PositionSnapshot(
                pair=pair,
                entry_price=pos.entry_price,
                size=pos.size,
                current_price=mark,
                market_value=value,
                unrealised_pnl=pos.unrealised_pnl(mark),
                stop_loss_price=pos.stop_loss_price,
            ))

        return PortfolioSnapshot(
            timestamp=datetime.now(timezone.utc),
            capital=self.manager.capital,
            market_value=market_value,
            total_value=self.manager.capital + market_value,
            realised_pnl=self.manager.total_realised_pnl(),
            open_positions=open_snaps,
            total_trades=len(self.manager.closed_trades),
        )
