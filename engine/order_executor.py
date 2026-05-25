"""
OrderExecutor — vertaalt Signal + Profile naar acties op een PortfolioManager.

Eén executor per (profile × bot-proces). Stop-loss check heeft altijd voorrang
op signal-verwerking. Schrijft open-position-state naar Supabase (profile-aware).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from api import db
from data.market_filter import is_bull_market
from portfolio.manager import ClosedTrade, PortfolioManager
from portfolio.position import Position
from strategy.signal import Action, Signal


@dataclass
class ExecutionResult:
    signal: Signal
    action_taken: str           # 'OPENED' | 'CLOSED' | 'STOP_LOSS' | 'SKIPPED'
    detail: str
    position: Optional[Position] = None
    trade: Optional[ClosedTrade] = None


class OrderExecutor:
    def __init__(self, pm: PortfolioManager) -> None:
        self.pm = pm

    @property
    def profile_key(self) -> str:
        return self.pm.profile.key

    def handle_tick(self, signal: Signal, current_price: float) -> ExecutionResult:
        # 1. Stop loss heeft altijd voorrang
        open_pos = self.pm.get_open(signal.pair)
        if open_pos is not None and open_pos.is_stopped_out(current_price):
            trade = self.pm.close(signal.pair, current_price, reason="stop-loss")
            try: db.delete_open_position(self.profile_key, signal.pair)
            except Exception: pass
            return ExecutionResult(
                signal=signal, action_taken="STOP_LOSS",
                detail=f"stop @ {open_pos.stop_loss_price:.2f} geraakt (huidige prijs {current_price:.2f})",
                trade=trade,
            )

        # 2. Signal verwerken
        if signal.action == Action.BUY:
            if open_pos is not None:
                return ExecutionResult(signal, "SKIPPED", "al open positie op pair")
            # 200MA filter — alleen voor profielen die het opt-in hebben (Adaptief).
            # In bull market: pauzeer nieuwe entries; bestaande SELL/stop blijven normaal.
            if self.pm.profile.use_200ma_filter:
                try:
                    if is_bull_market():
                        return ExecutionResult(signal, "PAUSED", "bull market — BTC >3% boven 200MA")
                except Exception as e:
                    # Filter mag de tick niet stoppen; log en negeer
                    return ExecutionResult(signal, "SKIPPED", f"200MA-check faalde: {e}")
            if self.pm.at_max_positions():
                return ExecutionResult(signal, "SKIPPED", f"max posities bereikt ({self.pm.profile.max_positions})")
            if self.pm.capital <= 0:
                return ExecutionResult(signal, "SKIPPED", "geen capital")
            pos = self.pm.open_long(signal.pair, signal.price)
            if pos is None:
                return ExecutionResult(signal, "SKIPPED", "open_long gaf None (size 0?)")
            try:
                db.upsert_open_position(self.profile_key, pos.pair, pos.entry_price, pos.size,
                                        pos.stop_loss_price, pos.opened_at)
            except Exception: pass
            return ExecutionResult(
                signal=signal, action_taken="OPENED",
                detail=f"{pos.size:.6f} @ {pos.entry_price:.2f}, stop {pos.stop_loss_price:.2f}",
                position=pos,
            )

        if signal.action == Action.SELL:
            if open_pos is None:
                return ExecutionResult(signal, "SKIPPED", "geen open positie om te sluiten")
            trade = self.pm.close(signal.pair, signal.price, reason="sell-signal")
            try: db.delete_open_position(self.profile_key, signal.pair)
            except Exception: pass
            return ExecutionResult(
                signal=signal, action_taken="CLOSED",
                detail=f"pnl EUR {trade.pnl:+.2f}",
                trade=trade,
            )

        return ExecutionResult(signal, "SKIPPED", "HOLD")
