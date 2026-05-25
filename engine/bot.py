"""
Bot loop — evalueert per tick alle 4 profielen tegen dezelfde marktdata.

Eén tick:
  1. Voor elke pair: haal candles op, bereken RSI's. (1x per pair, niet 4x)
  2. Voor elk profiel: rebuild PortfolioManager uit Supabase, evalueer signaal,
     laat executor afhandelen, persist signals/trades/snapshot.

Aanroepen:
    python -m engine.bot              # elke 60s
    python -m engine.bot --once       # 1 tick en exit (handig voor GH Actions cron)
    python -m engine.bot --interval 30
"""
from __future__ import annotations

import argparse
import time
from datetime import datetime as _dt
from typing import Dict, List

import config
from api import db
from engine.logger import get_logger
from engine.order_executor import OrderExecutor
from portfolio.manager import PortfolioManager, PAPER_CAPITAL_DEFAULT
from portfolio.position import Position
from portfolio.tracker import PortfolioTracker
from profiles import Profile, all_profiles
from strategy.rsi_strategy import MarketState, compute_market_state, evaluate_from_state


def _hydrate(profile: Profile, log) -> PortfolioManager:
    """Rebuild PortfolioManager uit Supabase voor dit profiel."""
    pm = PortfolioManager(profile=profile, capital=PAPER_CAPITAL_DEFAULT)
    try:
        realised = db.realised_pnl_total(profile.key)
        opens = db.list_open_positions(profile.key)
        cash_in_positions = 0.0
        for o in opens:
            opened_at = o["opened_at"]
            if isinstance(opened_at, str):
                opened_at = _dt.fromisoformat(opened_at.replace("Z", "+00:00"))
            pos = Position(
                pair=o["pair"],
                entry_price=float(o["entry_price"]),
                size=float(o["size"]),
                stop_loss_price=float(o["stop_loss_price"]),
                opened_at=opened_at,
            )
            pm.open_positions[pos.pair] = pos
            cash_in_positions += pos.entry_value
        pm.capital = PAPER_CAPITAL_DEFAULT + realised - cash_in_positions
        log.info(f"  [{profile.label}] HYDRATED cap=EUR {pm.capital:.2f}  open={len(opens)}  realised={realised:+.2f}")
    except Exception as e:
        log.error(f"  [{profile.label}] DB hydrate faalde, val terug op default cap: {e}")
    return pm


def _fetch_market_data(log) -> Dict[str, MarketState]:
    """Eén ophaalmoment per pair — dezelfde MarketState voor alle 4 profielen."""
    states: Dict[str, MarketState] = {}
    for pair in config.PAIRS:
        try:
            states[pair] = compute_market_state(pair)
        except Exception as e:
            log.error(f"{pair} marktdata fetch faalde: {e}")
    return states


def run_tick(profiles: List[Profile]) -> None:
    log = get_logger()
    market = _fetch_market_data(log)
    if not market:
        log.error("Geen marktdata beschikbaar — tick overgeslagen")
        return

    for pair, state in market.items():
        log.info(f"MARKET {pair}  price={state.price:.2f}  rsi15m={state.rsi_15m:.1f}  rsi1h={state.rsi_1h:.1f}")

    for profile in profiles:
        pm = _hydrate(profile, log)
        executor = OrderExecutor(pm)
        tracker = PortfolioTracker(pm)
        prices: Dict[str, float] = {}

        for pair, state in market.items():
            prices[pair] = state.price
            signal = evaluate_from_state(state, profile)
            result = executor.handle_tick(signal, state.price)

            log.info(f"  [{profile.label}] {pair} -> {result.action_taken}  ({result.detail})")

            try:
                db.insert_signal(signal, profile.key)
                if result.trade is not None:
                    db.insert_trade(result.trade, profile.key)
            except Exception as e:
                log.error(f"  [{profile.label}] DB write faalde ({pair}): {e}")

        snap = tracker.snapshot(prices)
        log.info(
            f"  [{profile.label}] PORTFOLIO total=EUR {snap.total_value:.2f}  "
            f"cash=EUR {snap.capital:.2f}  realised=EUR {snap.realised_pnl:+.2f}  "
            f"open={len(snap.open_positions)}"
        )
        try:
            db.insert_portfolio_snapshot(snap, profile.key)
        except Exception as e:
            log.error(f"  [{profile.label}] snapshot write faalde: {e}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="één tick en exit (debug/cron)")
    parser.add_argument("--interval", type=int, default=60, help="seconden tussen ticks")
    parser.add_argument("--max-ticks", type=int, default=0,
                        help="exit na N ticks (0 = oneindig). Voor GH Actions cron: 5 ticks van 60s = ~4 min")
    parser.add_argument("--profile", help="alleen 1 profile evalueren (debug)")
    args = parser.parse_args()

    log = get_logger()
    profiles = [p for p in all_profiles() if not args.profile or p.key == args.profile]
    log.info(
        f"BOT START  env={config.ENV}  exchange={config.EXCHANGE}  pairs={config.PAIRS}  "
        f"interval={args.interval}s  profiles={[p.key for p in profiles]}"
    )

    ticks_done = 0
    try:
        while True:
            run_tick(profiles)
            ticks_done += 1
            if args.once or (args.max_ticks and ticks_done >= args.max_ticks):
                log.info(f"BOT STOP — {ticks_done} tick(s) gedaan")
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("BOT STOP (Ctrl+C)")


if __name__ == "__main__":
    main()
