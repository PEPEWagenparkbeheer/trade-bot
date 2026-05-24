"""
Supabase-client wrappers — profile-aware.

Twee client-instanties:
- write_client(): service-role key, writes vanaf engine
- read_client():  anon key, reads vanaf FastAPI routes

Alle data wordt per `profile` opgeslagen (kolom in bot_* tabellen).
Reads accepteren een optioneel `profile=` filter; None = alle profielen.
"""
from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from typing import Any, Dict, List, Optional

from supabase import Client, create_client

import config
from portfolio.manager import ClosedTrade
from portfolio.tracker import PortfolioSnapshot
from strategy.signal import Signal


@lru_cache(maxsize=1)
def write_client() -> Client:
    if not (config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY):
        raise RuntimeError("SUPABASE_URL en SUPABASE_SERVICE_KEY moeten gezet zijn")
    return create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)


@lru_cache(maxsize=1)
def read_client() -> Client:
    if not (config.SUPABASE_URL and config.SUPABASE_ANON_KEY):
        raise RuntimeError("SUPABASE_URL en SUPABASE_ANON_KEY moeten gezet zijn")
    return create_client(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# --- writes (engine) ---------------------------------------------------------

def insert_signal(signal: Signal, profile: str) -> None:
    write_client().table("bot_signals").insert({
        "profile":    profile,
        "pair":       signal.pair,
        "action":     signal.action.value,
        "price":      signal.price,
        "rsi_15m":    signal.rsi_15m,
        "rsi_1h":     signal.rsi_1h,
        "reason":     signal.reason,
        "created_at": _iso(signal.created_at),
    }).execute()


def insert_trade(trade: ClosedTrade, profile: str) -> None:
    write_client().table("bot_trades").insert({
        "profile":     profile,
        "pair":        trade.pair,
        "entry_price": trade.entry_price,
        "exit_price":  trade.exit_price,
        "size":        trade.size,
        "pnl":         trade.pnl,
        "reason":      trade.reason,
        "opened_at":   _iso(trade.opened_at),
        "closed_at":   _iso(trade.closed_at),
    }).execute()


def insert_portfolio_snapshot(snap: PortfolioSnapshot, profile: str) -> None:
    write_client().table("bot_portfolio").insert({
        "profile":        profile,
        "capital":        snap.capital,
        "market_value":   snap.market_value,
        "total_value":    snap.total_value,
        "realised_pnl":   snap.realised_pnl,
        "open_positions": len(snap.open_positions),
        "snapshot_at":    _iso(snap.timestamp),
    }).execute()


def upsert_open_position(profile: str, pair: str, entry_price: float, size: float,
                         stop_loss_price: float, opened_at: datetime) -> None:
    write_client().table("bot_open_positions").upsert({
        "profile":         profile,
        "pair":            pair,
        "entry_price":     entry_price,
        "size":            size,
        "stop_loss_price": stop_loss_price,
        "opened_at":       _iso(opened_at),
    }, on_conflict="pair,profile").execute()


def delete_open_position(profile: str, pair: str) -> None:
    write_client().table("bot_open_positions").delete().eq("pair", pair).eq("profile", profile).execute()


# --- reads (api) -------------------------------------------------------------

def _maybe_filter(query, profile: Optional[str]):
    return query.eq("profile", profile) if profile else query


def latest_signals(limit: int = 50, profile: Optional[str] = None) -> List[Dict[str, Any]]:
    q = read_client().table("bot_signals").select("*").order("created_at", desc=True).limit(limit)
    return _maybe_filter(q, profile).execute().data or []


def latest_trades(limit: int = 50, profile: Optional[str] = None) -> List[Dict[str, Any]]:
    q = read_client().table("bot_trades").select("*").order("closed_at", desc=True).limit(limit)
    return _maybe_filter(q, profile).execute().data or []


def latest_portfolio(limit: int = 200, profile: Optional[str] = None) -> List[Dict[str, Any]]:
    q = read_client().table("bot_portfolio").select("*").order("snapshot_at", desc=True).limit(limit)
    return _maybe_filter(q, profile).execute().data or []


def latest_portfolio_one(profile: str) -> Dict[str, Any] | None:
    res = read_client().table("bot_portfolio").select("*").eq("profile", profile)\
        .order("snapshot_at", desc=True).limit(1).execute()
    return (res.data or [None])[0]


def realised_pnl_total(profile: str) -> float:
    """Som van pnl over alle afgesloten trades van dit profiel."""
    res = read_client().table("bot_trades").select("pnl").eq("profile", profile).execute()
    return float(sum(float(r["pnl"]) for r in (res.data or [])))


def trade_stats(profile: str) -> Dict[str, Any]:
    """Aantal trades + winrate voor compare-view."""
    res = read_client().table("bot_trades").select("pnl").eq("profile", profile).execute()
    rows = res.data or []
    total = len(rows)
    wins = sum(1 for r in rows if float(r["pnl"]) > 0)
    return {"total_trades": total, "wins": wins, "winrate": wins / total if total > 0 else 0.0}


def list_open_positions(profile: Optional[str] = None) -> List[Dict[str, Any]]:
    q = read_client().table("bot_open_positions").select("*")
    return _maybe_filter(q, profile).execute().data or []


if __name__ == "__main__":
    print(f"URL: {config.SUPABASE_URL}")
    print(f"Signals in db: {len(latest_signals(5))}")
    print(f"Trades in db:  {len(latest_trades(5))}")
    print(f"Snapshots:     {len(latest_portfolio(5))}")
