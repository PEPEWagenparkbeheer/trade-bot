"""
Chat-endpoint dat Claude Haiku aanroept met live multi-profile bot-context.

Optioneel `profile` param: als gegeven, focust de assistant op dat profiel.
Anders krijgt hij overzicht van alle 4 profielen.
"""
from __future__ import annotations

from typing import List, Literal, Optional

from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
from api import db
from data.fetcher import fetch_candles, to_dataframe
from data.indicators import latest_rsi
from profiles import PROFILES, all_profiles

router = APIRouter(prefix="/api/chat", tags=["chat"])

MODEL = "claude-haiku-4-5-20251001"


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    profile: Optional[str] = None  # focus op één profiel, of None = alle 4


class ChatResponse(BaseModel):
    reply: str


def _current_rsi(pair: str, tf: str) -> float | None:
    try:
        df = to_dataframe(fetch_candles(pair, tf, limit=100))
        return latest_rsi(df["close"]) if not df.empty else None
    except Exception:
        return None


def _build_context(profile_key: Optional[str]) -> str:
    parts: list[str] = []
    parts.append("# Bot configuratie")
    parts.append(f"- Mode: {config.ENV} (paper trading)")
    parts.append(f"- Exchange: {config.EXCHANGE}")
    parts.append(f"- Pairs: {', '.join(config.PAIRS)}")
    parts.append(f"- Entry tf: {config.TIMEFRAME_ENTRY}  Trend tf: {config.TIMEFRAME_TREND}")
    parts.append(f"- Start kapitaal per profiel: EUR 1000")

    parts.append("\n# Profielen (alle 4 draaien parallel met dezelfde marktdata)")
    for p in all_profiles():
        focus = " ← FOCUS" if p.key == profile_key else ""
        tf = "geen" if p.trend_filter is None else f"<{p.trend_filter}"
        parts.append(
            f"- {p.label}: BUY<{p.rsi_oversold} (trendfilter {tf}), SELL>{p.rsi_overbought}, "
            f"max {p.max_positions} posities, risk {p.risk_per_trade*100:.0f}%, stop {p.stop_loss_pct*100:.0f}%{focus}"
        )

    parts.append("\n# Huidige markt")
    for pair in config.PAIRS:
        rsi_15m = _current_rsi(pair, config.TIMEFRAME_ENTRY)
        rsi_1h = _current_rsi(pair, config.TIMEFRAME_TREND)
        parts.append(f"- {pair}: rsi15m={rsi_15m:.1f if rsi_15m else 0}  rsi1h={rsi_1h:.1f if rsi_1h else 0}" if rsi_15m else f"- {pair}: marktdata n/a")

    targets = [profile_key] if profile_key else [p.key for p in all_profiles()]
    parts.append("\n# Portfolio per profiel")
    for key in targets:
        snap = db.latest_portfolio_one(key)
        realised = db.realised_pnl_total(key)
        stats = db.trade_stats(key)
        label = PROFILES[key].label
        if snap:
            parts.append(
                f"- {label}: total EUR {float(snap['total_value']):.2f} "
                f"(cash {float(snap['capital']):.2f}, realised {realised:+.2f}, "
                f"{stats['total_trades']} trades, winrate {stats['winrate']*100:.0f}%)"
            )
        else:
            parts.append(f"- {label}: nog geen snapshot")

    if profile_key:
        sigs = db.latest_signals(limit=10, profile=profile_key)
        if sigs:
            parts.append(f"\n# Laatste 10 signalen [{PROFILES[profile_key].label}]")
            for s in sigs:
                parts.append(f"- {s['created_at']} {s['pair']} {s['action']} rsi15m={float(s['rsi_15m']):.1f}")
        trades = db.latest_trades(limit=5, profile=profile_key)
        if trades:
            parts.append(f"\n# Laatste 5 trades [{PROFILES[profile_key].label}]")
            for t in trades:
                parts.append(f"- {t['closed_at']} {t['pair']} pnl EUR {float(t['pnl']):+.2f}")

    return "\n".join(parts)


SYSTEM_PROMPT = """Je bent de assistant in een multi-profile paper-trading crypto bot voor Joep.

De bot draait vier risicoprofielen tegelijk (Laag, Gemiddeld, Hoog, Extreem) met dezelfde
marktdata maar verschillende RSI-drempels, position sizing en stop loss. Alles is paper
(gesimuleerd geld, live Bitvavo data, EUR 1000 startkapitaal per profiel).

Antwoord in het Nederlands, kort en concreet. Geef nooit beleggingsadvies — alleen
technische uitleg van wat de bot doet/zou doen. Vergelijk gerust profielen als de vraag
daarover gaat (bv. "welk profiel doet het beter vandaag?")."""


@router.post("", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    if not config.ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY niet gezet in .env")
    if not req.messages:
        raise HTTPException(400, "Geef ten minste 1 message mee")
    if req.profile and req.profile not in PROFILES:
        raise HTTPException(400, f"onbekend profiel: {req.profile}")

    client = Anthropic(api_key=config.ANTHROPIC_API_KEY)
    context = _build_context(req.profile)
    system = SYSTEM_PROMPT + "\n\n# Huidige bot context (live)\n\n" + context

    resp = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=system,
        messages=[m.model_dump(exclude={"profile"}) if False else {"role": m.role, "content": m.content} for m in req.messages],
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    return ChatResponse(reply=text)
