from fastapi import APIRouter

import config

router = APIRouter(prefix="/api/status", tags=["status"])


@router.get("")
def get_status():
    """Configuratie/health-info voor het dashboard om de bot-modus te tonen."""
    return {
        "env":              config.ENV,
        "exchange":         config.EXCHANGE,
        "pairs":            config.PAIRS,
        "timeframe_entry":  config.TIMEFRAME_ENTRY,
        "timeframe_trend":  config.TIMEFRAME_TREND,
        "rsi_period":       config.RSI_PERIOD,
        "rsi_oversold":     config.RSI_OVERSOLD,
        "rsi_overbought":   config.RSI_OVERBOUGHT,
        "risk_per_trade":   config.RISK_PER_TRADE,
        "stop_loss_pct":    config.STOP_LOSS_PCT,
        "paper_capital":    config.PAPER_CAPITAL,
    }
