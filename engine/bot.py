"""
Bot = de main loop. Eén tick = voor elke pair: data ophalen, signaal genereren,
executor laten beslissen, alles loggen, dan slapen tot volgende tick.

Aanroepen:
    python -m engine.bot              # draait elke 60s
    python -m engine.bot --once       # 1 tick en stoppen (handig voor testen)
    python -m engine.bot --interval 30
"""
from __future__ import annotations

import argparse
import time

import config
from api import db
from engine.logger import get_logger
from engine.order_executor import OrderExecutor
from portfolio.manager import PortfolioManager
from portfolio.tracker import PortfolioTracker
from strategy.rsi_strategy import evaluate


def run_tick(pm: PortfolioManager, executor: OrderExecutor, tracker: PortfolioTracker) -> None:
    log = get_logger()
    prices: dict[str, float] = {}

    for pair in config.PAIRS:
        try:
            signal = evaluate(pair)
        except Exception as e:
            log.error(f"{pair} signal-eval faalde: {e}")
            continue

        prices[pair] = signal.price
        result = executor.handle_tick(signal, signal.price)

        log.info(
            f"{signal.pair}  rsi15m={signal.rsi_15m:.1f}  rsi1h={signal.rsi_1h:.1f}  "
            f"price={signal.price:.2f}  -> {result.action_taken}  ({result.detail})"
        )

        # Persist signal naar Supabase. DB-falen mag de tick niet stoppen.
        try:
            db.insert_signal(signal)
            if result.trade is not None:
                db.insert_trade(result.trade)
        except Exception as e:
            log.error(f"Supabase write faalde ({signal.pair}): {e}")

    snap = tracker.snapshot(prices)
    log.info(
        f"PORTFOLIO  cash=EUR {snap.capital:.2f}  market=EUR {snap.market_value:.2f}  "
        f"total=EUR {snap.total_value:.2f}  realisedPnL=EUR {snap.realised_pnl:+.2f}  "
        f"trades={snap.total_trades}  open={len(snap.open_positions)}"
    )

    try:
        db.insert_portfolio_snapshot(snap)
    except Exception as e:
        log.error(f"Supabase snapshot write faalde: {e}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="één tick en exit (debug)")
    parser.add_argument("--interval", type=int, default=60, help="seconden tussen ticks")
    args = parser.parse_args()

    log = get_logger()
    log.info(
        f"BOT START  env={config.ENV}  exchange={config.EXCHANGE}  pairs={config.PAIRS}  "
        f"interval={args.interval}s  startCapital=EUR {config.PAPER_CAPITAL}"
    )

    pm = PortfolioManager()
    executor = OrderExecutor(pm)
    tracker = PortfolioTracker(pm)

    # Hydrateer capital + open posities uit DB zodat bot herstart-bestendig is
    try:
        realised = db.realised_pnl_total()
        opens = db.list_open_positions()
        cash_in_positions = 0.0
        from portfolio.position import Position
        from datetime import datetime as _dt
        for o in opens:
            pos = Position(
                pair=o["pair"],
                entry_price=float(o["entry_price"]),
                size=float(o["size"]),
                stop_loss_price=float(o["stop_loss_price"]),
                opened_at=_dt.fromisoformat(o["opened_at"].replace("Z","+00:00")) if isinstance(o["opened_at"], str) else o["opened_at"],
            )
            pm.open_positions[pos.pair] = pos
            cash_in_positions += pos.entry_value
        pm.capital = config.PAPER_CAPITAL + realised - cash_in_positions
        log.info(f"HYDRATED capital=EUR {pm.capital:.2f}  open={len(opens)}  realised={realised:+.2f}")
    except Exception as e:
        log.error(f"DB hydrate faalde, val terug op paper_capital: {e}")

    try:
        while True:
            run_tick(pm, executor, tracker)
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("BOT STOP (Ctrl+C)")


if __name__ == "__main__":
    main()
