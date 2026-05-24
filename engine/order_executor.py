"""
OrderExecutor = de brug tussen Signal en PortfolioManager.

In paper-modus voert hij orders direct uit tegen de PortfolioManager
(geen exchange API call). In live-modus zal dit straks via ccxt.bitvavo
.create_order(...) gaan — zelfde interface, andere implementatie.

Stop-loss handling: bij elke tick checken we eerst of een open positie
zijn stop loss heeft geraakt. Dat heeft voorrang op signal-based exits.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import config
from api import db
from portfolio.manager import ClosedTrade, PortfolioManager
from portfolio.position import Position
from strategy.signal import Action, Signal


@dataclass
class ExecutionResult:
    """Wat er met dit signaal gebeurd is — voor de logger en het dashboard."""
    signal: Signal
    action_taken: str           # 'OPENED' | 'CLOSED' | 'STOP_LOSS' | 'SKIPPED'
    detail: str
    position: Optional[Position] = None
    trade: Optional[ClosedTrade] = None


class OrderExecutor:
    def __init__(self, pm: PortfolioManager) -> None:
        self.pm = pm

    def handle_tick(self, signal: Signal, current_price: float) -> ExecutionResult:
        """
        Volgorde van handelen:
          1. Stop loss check op open positie (force close indien geraakt)
          2. Signal verwerking (BUY opent, SELL sluit, HOLD doet niks)
        """
        # 1. Stop loss heeft altijd voorrang
        open_pos = self.pm.get_open(signal.pair)
        if open_pos is not None and open_pos.is_stopped_out(current_price):
            trade = self.pm.close(signal.pair, current_price, reason="stop-loss")
            try: db.delete_open_position(signal.pair)
            except Exception: pass
            return ExecutionResult(
                signal=signal,
                action_taken="STOP_LOSS",
                detail=f"stop @ {open_pos.stop_loss_price:.2f} geraakt (huidige prijs {current_price:.2f})",
                trade=trade,
            )

        # 2. Signal verwerken
        if signal.action == Action.BUY:
            if open_pos is not None:
                return ExecutionResult(signal, "SKIPPED", "al open positie op pair")
            if self.pm.capital <= 0:
                return ExecutionResult(signal, "SKIPPED", "geen capital")
            pos = self.pm.open_long(signal.pair, signal.price)
            if pos is None:
                return ExecutionResult(signal, "SKIPPED", "open_long gaf None (size 0?)")
            try: db.upsert_open_position(pos.pair, pos.entry_price, pos.size, pos.stop_loss_price, pos.opened_at)
            except Exception: pass
            return ExecutionResult(
                signal=signal,
                action_taken="OPENED",
                detail=f"{pos.size:.6f} @ {pos.entry_price:.2f}, stop {pos.stop_loss_price:.2f}",
                position=pos,
            )

        if signal.action == Action.SELL:
            if open_pos is None:
                return ExecutionResult(signal, "SKIPPED", "geen open positie om te sluiten")
            trade = self.pm.close(signal.pair, signal.price, reason="sell-signal")
            try: db.delete_open_position(signal.pair)
            except Exception: pass
            return ExecutionResult(
                signal=signal,
                action_taken="CLOSED",
                detail=f"pnl EUR {trade.pnl:+.2f}",
                trade=trade,
            )

        return ExecutionResult(signal, "SKIPPED", "HOLD")
