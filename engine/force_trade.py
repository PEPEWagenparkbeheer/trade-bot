"""
Force-trade helper — open of demo-cycle een paper-positie voor een profiel.

Gebruik:
    python -m engine.force_trade --profile gemiddeld --pair BTC/EUR --action demo
    python -m engine.force_trade --profile extreem --pair ETH/EUR --action open

Schrijft signaal + trade + snapshot naar Supabase voor dat profiel.
"""
from __future__ import annotations

import argparse

from api import db
from data.fetcher import fetch_candles
from engine.logger import get_logger
from portfolio.manager import PortfolioManager, PAPER_CAPITAL_DEFAULT
from portfolio.tracker import PortfolioTracker
from profiles import get_profile
from strategy.signal import Action, Signal


def _current_price(pair: str) -> float:
    candles = fetch_candles(pair, "15m", limit=1)
    return float(candles[-1].close)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="gemiddeld", help="profile key (laag/gemiddeld/hoog/extreem)")
    parser.add_argument("--pair", default="BTC/EUR")
    parser.add_argument("--action", choices=["open", "close", "demo"], required=True,
                        help="demo = complete open+close cycle voor dashboard demo")
    parser.add_argument("--pnl-pct", type=float, default=0.01, help="winst% voor demo (0.01 = +1%)")
    args = parser.parse_args()

    profile = get_profile(args.profile)
    log = get_logger("force")

    pm = PortfolioManager(profile=profile, capital=PAPER_CAPITAL_DEFAULT)
    snap = db.latest_portfolio_one(profile.key)
    if snap is not None:
        pm.capital = float(snap["capital"])

    price = _current_price(args.pair)
    log.info(f"FORCE [{profile.label}] {args.pair} {args.action}  price=EUR {price:.2f}  cap=EUR {pm.capital:.2f}")

    if args.action == "open":
        pos = pm.open_long(args.pair, price)
        if pos is None:
            log.error("Open faalde (al open / max bereikt / geen capital)")
            return
        log.info(f"OPENED {pos.size:.6f} @ {pos.entry_price:.2f}, stop {pos.stop_loss_price:.2f}")
        db.insert_signal(Signal(pair=args.pair, action=Action.BUY, price=price,
                                rsi_15m=0, rsi_1h=0, reason=f"FORCE OPEN [{profile.label}]"), profile.key)
        db.upsert_open_position(profile.key, pos.pair, pos.entry_price, pos.size, pos.stop_loss_price, pos.opened_at)
        return

    # close/demo: open + close in 1 cycle
    tracker = PortfolioTracker(pm)
    pos = pm.open_long(args.pair, price)
    if pos is None:
        log.error("Open faalde voor demo-cycle")
        return
    db.insert_signal(Signal(pair=args.pair, action=Action.BUY, price=price,
                            rsi_15m=0, rsi_1h=0, reason=f"DEMO open [{profile.label}]"), profile.key)
    db.insert_portfolio_snapshot(tracker.snapshot({args.pair: price}), profile.key)

    exit_price = price * (1 + args.pnl_pct)
    trade = pm.close(args.pair, exit_price, reason=f"DEMO close ({args.pnl_pct*100:+.1f}%)")
    log.info(f"DEMO TRADE [{profile.label}] {args.pair}: {price:.2f} -> {exit_price:.2f}  pnl=EUR {trade.pnl:+.2f}")
    db.insert_signal(Signal(pair=args.pair, action=Action.SELL, price=exit_price,
                            rsi_15m=0, rsi_1h=0, reason=f"DEMO close [{profile.label}]"), profile.key)
    db.insert_trade(trade, profile.key)
    db.insert_portfolio_snapshot(tracker.snapshot({args.pair: exit_price}), profile.key)


if __name__ == "__main__":
    main()
