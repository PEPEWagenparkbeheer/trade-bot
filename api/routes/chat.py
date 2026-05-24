"""
Chat-endpoint dat Claude (Haiku 4.5) aanroept met live bot-context.

De assistant krijgt elke vraag:
- system prompt = uitleg over de bot architectuur + parameters
- context blok = actuele status, laatste 10 signalen, laatste 5 trades, portfolio snapshot
- conversation history = client-side bijgehouden, in elke request meegestuurd

Zo kan hij vragen beantwoorden als "waarom geen trade?", "hoeveel staat er open?",
"wat zou er nu nodig zijn om te kopen?" met live data.
"""
from __future__ import annotations

import json
from typing import List, Literal

from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
from api import db
from data.fetcher import fetch_candles
from data.indicators import latest_rsi
from data.fetcher import to_dataframe

router = APIRouter(prefix="/api/chat", tags=["chat"])

MODEL = "claude-haiku-4-5-20251001"


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]


class ChatResponse(BaseModel):
    reply: str


def _current_rsi(pair: str, tf: str) -> float | None:
    try:
        df = to_dataframe(fetch_candles(pair, tf, limit=100))
        return latest_rsi(df["close"]) if not df.empty else None
    except Exception:
        return None


def _build_context() -> str:
    """Bouw een snapshot blok van actuele bot-state om aan Claude te geven."""
    parts: list[str] = []
    parts.append(f"# Bot configuratie")
    parts.append(f"- Mode: {config.ENV} (paper trading, fake geld)")
    parts.append(f"- Exchange: {config.EXCHANGE} (live marktdata, gesimuleerde orders)")
    parts.append(f"- Pairs: {', '.join(config.PAIRS)}")
    parts.append(f"- Entry timeframe: {config.TIMEFRAME_ENTRY}, trend timeframe: {config.TIMEFRAME_TREND}")
    parts.append(f"- Strategie regels:")
    parts.append(f"  BUY  = RSI {config.TIMEFRAME_ENTRY} < {config.RSI_OVERSOLD} EN RSI {config.TIMEFRAME_TREND} < {config.RSI_TREND_FILTER}")
    parts.append(f"  SELL = RSI {config.TIMEFRAME_ENTRY} > {config.RSI_OVERBOUGHT}  OF stop loss geraakt")
    parts.append(f"- Position sizing: {config.RISK_PER_TRADE*100:.0f}% risk per trade, {config.STOP_LOSS_PCT*100:.0f}% stop loss")
    parts.append(f"- Start kapitaal: EUR {config.PAPER_CAPITAL}")

    parts.append(f"\n# Huidige marktstatus")
    for pair in config.PAIRS:
        rsi_15m = _current_rsi(pair, config.TIMEFRAME_ENTRY)
        rsi_1h = _current_rsi(pair, config.TIMEFRAME_TREND)
        rsi_15m_str = f"{rsi_15m:.1f}" if rsi_15m is not None else "n/a"
        rsi_1h_str = f"{rsi_1h:.1f}" if rsi_1h is not None else "n/a"
        parts.append(f"- {pair}: RSI15m={rsi_15m_str}  RSI1h={rsi_1h_str}")

    snap = db.latest_portfolio_one()
    if snap:
        parts.append(f"\n# Portfolio snapshot")
        parts.append(f"- Cash: EUR {float(snap['capital']):.2f}")
        parts.append(f"- Market value (open posities): EUR {float(snap['market_value']):.2f}")
        parts.append(f"- Total value: EUR {float(snap['total_value']):.2f}")
        parts.append(f"- Realised PnL: EUR {float(snap['realised_pnl']):+.2f}")
        parts.append(f"- Open posities: {snap['open_positions']}")
        parts.append(f"- Snapshot tijd: {snap['snapshot_at']}")

    sigs = db.latest_signals(limit=10)
    if sigs:
        parts.append(f"\n# Laatste 10 signalen")
        for s in sigs:
            parts.append(f"- {s['created_at']}  {s['pair']}  {s['action']}  rsi15m={float(s['rsi_15m']):.1f}  rsi1h={float(s['rsi_1h']):.1f}  ({s['reason']})")

    trades = db.latest_trades(limit=5)
    if trades:
        parts.append(f"\n# Laatste 5 trades")
        for t in trades:
            parts.append(f"- {t['closed_at']}  {t['pair']}  pnl EUR {float(t['pnl']):+.2f}  ({t['reason']})")
    else:
        parts.append(f"\n# Trades\nNog geen afgesloten trades.")

    return "\n".join(parts)


SYSTEM_PROMPT = """Je bent de assistant in een paper-trading crypto bot voor Joep.

Joep leert van nul over trading bots. Hij heeft de bot zelf gebouwd met behulp van Claude Code.
De bot draait een RSI-strategie op Bitvavo public data, simuleert orders (paper), en
slaat alles op in Supabase. Het dashboard waar deze chat in zit toont real-time signalen,
trades en portfolio waarde.

Antwoord in het Nederlands, kort en concreet. Geef trading-advies alleen als technische uitleg
(wat de bot doet en waarom), nooit als beleggingsadvies. Als data ontbreekt zeg dat eerlijk.

Gebruik de context (bot config + huidige RSI + portfolio + recent signalen/trades) hieronder
om vragen te beantwoorden over WAT de bot nu zou doen, waarom er wel/niet getraded wordt,
en hoe parameters de strategie beïnvloeden."""


@router.post("", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    if not config.ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY niet gezet in .env")
    if not req.messages:
        raise HTTPException(400, "Geef ten minste 1 message mee")

    client = Anthropic(api_key=config.ANTHROPIC_API_KEY)

    context = _build_context()
    system = SYSTEM_PROMPT + "\n\n# Huidige bot context (live data)\n\n" + context

    resp = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=system,
        messages=[m.model_dump() for m in req.messages],
    )

    # Concat alle text blocks
    text = "".join(b.text for b in resp.content if b.type == "text")
    return ChatResponse(reply=text)
