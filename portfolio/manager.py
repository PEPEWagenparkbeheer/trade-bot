"""
PortfolioManager = in-memory boekhouding van capital + open posities.

Eén instantie per bot-proces. Persistence (Supabase) komt in fase 6 — voor
nu houdt deze klasse alles in geheugen, zodat strategie + engine eerst goed
testbaar zijn zonder database.

Position sizing volgt de risk-based formule:
    risk_eur     = capital * RISK_PER_TRADE        (bv. 2%)
    stop_pct     = STOP_LOSS_PCT                   (bv. 3%)
    position_eur = risk_eur / stop_pct             (= capital * 0.667 bij 2%/3%)

Dat betekent: per trade riskeren we 2% van het kapitaal, niet 2% positie.
Een 3% stop loss op die positie = 2% verlies op het hele portfolio. Klassiek
"risk first" position sizing.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

import config
from portfolio.position import Position


@dataclass
class ClosedTrade:
    """Audit-record van een afgesloten trade. Vrijwel direct te dumpen in Supabase."""
    pair: str
    entry_price: float
    exit_price: float
    size: float
    pnl: float
    opened_at: datetime
    closed_at: datetime
    reason: str  # 'sell-signal' of 'stop-loss'


@dataclass
class PortfolioManager:
    capital: float = field(default_factory=lambda: config.PAPER_CAPITAL)
    open_positions: Dict[str, Position] = field(default_factory=dict)
    closed_trades: List[ClosedTrade] = field(default_factory=list)

    # --- queries -------------------------------------------------------------

    def has_open(self, pair: str) -> bool:
        return pair in self.open_positions

    def get_open(self, pair: str) -> Optional[Position]:
        return self.open_positions.get(pair)

    def total_value(self, prices: Dict[str, float]) -> float:
        """Cash + market value van alle open posities."""
        market = sum(
            pos.current_value(prices[pair])
            for pair, pos in self.open_positions.items()
            if pair in prices
        )
        return self.capital + market

    def total_realised_pnl(self) -> float:
        return sum(t.pnl for t in self.closed_trades)

    # --- mutations -----------------------------------------------------------

    def open_long(self, pair: str, price: float) -> Optional[Position]:
        """
        Open een long positie op `pair` tegen `price`.
        Geeft None terug als er al een open positie is, of als er onvoldoende capital is.
        """
        if self.has_open(pair):
            return None  # we staan max 1 positie per pair toe

        risk_eur = self.capital * config.RISK_PER_TRADE
        position_eur = risk_eur / config.STOP_LOSS_PCT

        # Kunnen we dat überhaupt betalen?
        if position_eur > self.capital:
            position_eur = self.capital  # niet meer kopen dan we hebben
        if position_eur <= 0:
            return None

        size = position_eur / price
        stop_loss = price * (1 - config.STOP_LOSS_PCT)

        position = Position(
            pair=pair, entry_price=price, size=size, stop_loss_price=stop_loss
        )
        self.open_positions[pair] = position
        self.capital -= position.entry_value
        return position

    def close(self, pair: str, exit_price: float, reason: str) -> Optional[ClosedTrade]:
        """Sluit de open positie op `pair` en boek de proceeds terug naar capital."""
        position = self.open_positions.pop(pair, None)
        if position is None:
            return None

        proceeds = position.current_value(exit_price)
        pnl = proceeds - position.entry_value
        self.capital += proceeds

        trade = ClosedTrade(
            pair=pair,
            entry_price=position.entry_price,
            exit_price=exit_price,
            size=position.size,
            pnl=pnl,
            opened_at=position.opened_at,
            closed_at=datetime.now(timezone.utc),
            reason=reason,
        )
        self.closed_trades.append(trade)
        return trade
