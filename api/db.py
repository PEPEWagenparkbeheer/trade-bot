"""
Supabase-client wrappers.

Twee instanties:
- write_client(): service-role key, gebruikt door de engine om trades/signals/portfolio te persisteren
- read_client():  anon key, gebruikt door de FastAPI routes om data voor het dashboard op te halen

Tabellen leven met prefix `bot_` zodat ze niet botsen met PEPE/autosearch data in
hetzelfde Supabase project.
"""
from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from typing import Any, Dict, List

from supabase import Client, create_client

import config
from portfolio.manager import ClosedTrade
from portfolio.tracker import PortfolioSnapshot
from strategy.signal import Signal


@lru_cache(maxsize=1)
def write_client() -> Client:
    """Engine-side client (service role — kan inserten en de RLS bypassen)."""
    if not (config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY):
        raise RuntimeError("SUPABASE_URL en SUPABASE_SERVICE_KEY moeten gezet zijn")
    return create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)


@lru_cache(maxsize=1)
def read_client() -> Client:
    """API-side client (anon key — alleen reads, conform RLS-policies)."""
    if not (config.SUPABASE_URL and config.SUPABASE_ANON_KEY):
        raise RuntimeError("SUPABASE_URL en SUPABASE_ANON_KEY moeten gezet zijn")
    return create_client(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)


# --- writes (engine) ---------------------------------------------------------

def _iso(dt: datetime) -> str:
    return dt.isoformat()


def insert_signal(signal: Signal) -> None:
    write_client().table("bot_signals").insert({
        "pair":       signal.pair,
        "action":     signal.action.value,
        "price":      signal.price,
        "rsi_15m":    signal.rsi_15m,
        "rsi_1h":     signal.rsi_1h,
        "reason":     signal.reason,
        "created_at": _iso(signal.created_at),
    }).execute()


def insert_trade(trade: ClosedTrade) -> None:
    write_client().table("bot_trades").insert({
        "pair":        trade.pair,
        "entry_price": trade.entry_price,
        "exit_price":  trade.exit_price,
        "size":        trade.size,
        "pnl":         trade.pnl,
        "reason":      trade.reason,
        "opened_at":   _iso(trade.opened_at),
        "closed_at":   _iso(trade.closed_at),
    }).execute()


def insert_portfolio_snapshot(snap: PortfolioSnapshot) -> None:
    write_client().table("bot_portfolio").insert({
        "capital":        snap.capital,
        "market_value":   snap.market_value,
        "total_value":    snap.total_value,
        "realised_pnl":   snap.realised_pnl,
        "open_positions": len(snap.open_positions),
        "snapshot_at":    _iso(snap.timestamp),
    }).execute()


# --- reads (api) -------------------------------------------------------------

def latest_signals(limit: int = 50) -> List[Dict[str, Any]]:
    res = read_client().table("bot_signals").select("*").order("created_at", desc=True).limit(limit).execute()
    return res.data or []


def latest_trades(limit: int = 50) -> List[Dict[str, Any]]:
    res = read_client().table("bot_trades").select("*").order("closed_at", desc=True).limit(limit).execute()
    return res.data or []


def latest_portfolio(limit: int = 200) -> List[Dict[str, Any]]:
    res = read_client().table("bot_portfolio").select("*").order("snapshot_at", desc=True).limit(limit).execute()
    return res.data or []


def latest_portfolio_one() -> Dict[str, Any] | None:
    res = read_client().table("bot_portfolio").select("*").order("snapshot_at", desc=True).limit(1).execute()
    return (res.data or [None])[0]


def realised_pnl_total() -> float:
    """Som van pnl over alle afgesloten trades — single source of truth voor cash."""
    res = read_client().table("bot_trades").select("pnl").execute()
    return float(sum(float(r["pnl"]) for r in (res.data or [])))


# --- Open positions persistence ----------------------------------------------

def list_open_positions() -> List[Dict[str, Any]]:
    res = read_client().table("bot_open_positions").select("*").execute()
    return res.data or []


def upsert_open_position(pair: str, entry_price: float, size: float, stop_loss_price: float, opened_at: datetime) -> None:
    write_client().table("bot_open_positions").upsert({
        "pair": pair,
        "entry_price": entry_price,
        "size": size,
        "stop_loss_price": stop_loss_price,
        "opened_at": _iso(opened_at),
    }, on_conflict="pair").execute()


def delete_open_position(pair: str) -> None:
    write_client().table("bot_open_positions").delete().eq("pair", pair).execute()


if __name__ == "__main__":
    # Smoke test: connectiviteit
    print(f"URL: {config.SUPABASE_URL}")
    print(f"Signals in db: {len(latest_signals(5))}")
    print(f"Trades in db:  {len(latest_trades(5))}")
    print(f"Snapshots:     {len(latest_portfolio(5))}")
