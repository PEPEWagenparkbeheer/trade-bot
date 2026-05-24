"""
PortfolioManager — boekhouding van capital + open posities voor één profiel.

Eén instantie per (profile × bot-proces). Risk en stop-loss komen uit het
gekoppelde Profile object i.p.v. uit globale config.

Position sizing volgt de risk-based formule:
    risk_eur     = capital * profile.risk_per_trade
    position_eur = risk_eur / profile.stop_loss_pct

Bij profile.max_positions worden nieuwe opens geweigerd zodra de cap
bereikt is — zo verschilt Laag (cap 1) van de rest (cap 2-4) ondanks dat
we nu 2 pairs hebben.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

from portfolio.position import Position
from profiles import Profile

PAPER_CAPITAL_DEFAULT = 1000.0


@dataclass
class ClosedTrade:
    pair: str
    entry_price: float
    exit_price: float
    size: float
    pnl: float
    opened_at: datetime
    closed_at: datetime
    reason: str  # 'sell-signal' | 'stop-loss' | 'FORCE ...'


@dataclass
class PortfolioManager:
    profile: Profile
    capital: float = PAPER_CAPITAL_DEFAULT
    open_positions: Dict[str, Position] = field(default_factory=dict)
    closed_trades: List[ClosedTrade] = field(default_factory=list)

    # --- queries -------------------------------------------------------------

    def has_open(self, pair: str) -> bool:
        return pair in self.open_positions

    def get_open(self, pair: str) -> Optional[Position]:
        return self.open_positions.get(pair)

    def at_max_positions(self) -> bool:
        return len(self.open_positions) >= self.profile.max_positions

    def total_value(self, prices: Dict[str, float]) -> float:
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
        if self.has_open(pair):
            return None  # max 1 positie per pair
        if self.at_max_positions():
            return None  # profile cap geraakt

        risk_eur = self.capital * self.profile.risk_per_trade
        position_eur = risk_eur / self.profile.stop_loss_pct

        if position_eur > self.capital:
            position_eur = self.capital
        if position_eur <= 0:
            return None

        size = position_eur / price
        stop_loss = price * (1 - self.profile.stop_loss_pct)

        position = Position(pair=pair, entry_price=price, size=size, stop_loss_price=stop_loss)
        self.open_positions[pair] = position
        self.capital -= position.entry_value
        return position

    def close(self, pair: str, exit_price: float, reason: str) -> Optional[ClosedTrade]:
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
