"""
Force-trade helper — opent of sluit handmatig een paper-positie.
Handig voor demo/testen zonder te wachten op een echte RSI-conditie.

Gebruik:
    python -m engine.force_trade --pair BTC/EUR --action open
    python -m engine.force_trade --pair BTC/EUR --action close

De trade wordt geboekt tegen de huidige Bitvavo-prijs en gepersisteerd naar
Supabase, precies zoals de bot zelf zou doen.

LET OP: deze tool werkt in paper-modus tegen een _losse_ PortfolioManager-instantie.
De normaal lopende bot (engine.bot) heeft zijn eigen in-memory state — die zal
het force-resultaat pas zien via Supabase. Voor de leerfase is dat genoeg
(dashboard wordt direct geüpdatet uit de DB).
"""
from __future__ import annotations

import argparse

from api import db
from data.fetcher import fetch_candles
from engine.logger import get_logger
from portfolio.manager import PortfolioManager
from strategy.signal import Action, Signal


def _current_price(pair: str) -> float:
    candles = fetch_candles(pair, "15m", limit=1)
    return float(candles[-1].close)


def _hydrate_portfolio_from_db() -> PortfolioManager:
    """
    Reconstrueer de portfolio uit de laatste Supabase snapshot + open trades.
    Simpele versie: capital komt uit laatste snapshot. Open posities worden
    NIET hersteld (omdat we die niet apart loggen) — voor demo werkt dat.
    """
    pm = PortfolioManager()
    snap = db.latest_portfolio_one()
    if snap is not None:
        pm.capital = float(snap["capital"])
    return pm


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pair", default="BTC/EUR")
    parser.add_argument("--action", choices=["open", "close", "demo"], required=True,
                        help="demo = complete open+close cycle voor dashboard demo")
    parser.add_argument("--pnl-pct", type=float, default=0.01,
                        help="winst% voor demo trade (default 0.01 = +1%)")
    args = parser.parse_args()

    log = get_logger("force")
    pm = _hydrate_portfolio_from_db()
    price = _current_price(args.pair)
    log.info(f"FORCE  pair={args.pair}  action={args.action}  price=EUR {price:.2f}  capital=EUR {pm.capital:.2f}")

    if args.action == "open":
        pos = pm.open_long(args.pair, price)
        if pos is None:
            log.error("Open faalde (geen capital of al open positie in geheugen)")
            return
        log.info(f"OPENED {pos.size:.6f} {args.pair} @ {pos.entry_price:.2f}, stop {pos.stop_loss_price:.2f}")
        # Log een synthetic BUY signaal voor dashboard zichtbaarheid
        db.insert_signal(Signal(
            pair=args.pair, action=Action.BUY, price=price,
            rsi_15m=0, rsi_1h=0, reason="FORCE OPEN (handmatig getriggerd)",
        ))
    elif args.action in ("close", "demo"):
        # Open + close + portfolio snapshot in 1 cycle voor dashboard demo
        from portfolio.tracker import PortfolioTracker
        tracker = PortfolioTracker(pm)

        pos = pm.open_long(args.pair, price)
        if pos is None:
            log.error("Kon geen demo-positie openen")
            return
        db.insert_signal(Signal(
            pair=args.pair, action=Action.BUY, price=price,
            rsi_15m=0, rsi_1h=0, reason="DEMO open",
        ))
        # Snapshot tussenstand (cash gedaald, market_value > 0)
        db.insert_portfolio_snapshot(tracker.snapshot({args.pair: price}))

        exit_price = price * (1 + args.pnl_pct)
        trade = pm.close(args.pair, exit_price, reason=f"DEMO close ({args.pnl_pct*100:+.1f}%)")
        log.info(f"DEMO TRADE {args.pair}: open {price:.2f} -> close {exit_price:.2f}  pnl=EUR {trade.pnl:+.2f}")
        db.insert_signal(Signal(
            pair=args.pair, action=Action.SELL, price=exit_price,
            rsi_15m=0, rsi_1h=0, reason="DEMO close",
        ))
        db.insert_trade(trade)
        # Snapshot eindstand (cash hoger, market_value=0, realised_pnl bijgewerkt)
        db.insert_portfolio_snapshot(tracker.snapshot({args.pair: exit_price}))


if __name__ == "__main__":
    main()
