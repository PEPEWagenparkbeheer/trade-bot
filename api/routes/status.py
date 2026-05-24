from fastapi import APIRouter

import config
from profiles import all_profiles

router = APIRouter(prefix="/api", tags=["status"])


@router.get("/status")
def get_status():
    return {
        "env":             config.ENV,
        "exchange":        config.EXCHANGE,
        "pairs":           config.PAIRS,
        "timeframe_entry": config.TIMEFRAME_ENTRY,
        "timeframe_trend": config.TIMEFRAME_TREND,
        "rsi_period":      config.RSI_PERIOD,
        "paper_capital":   1000.0,  # per profiel
        "profiles":        [
            {
                "key": p.key, "label": p.label, "color": p.color,
                "rsi_oversold": p.rsi_oversold, "rsi_overbought": p.rsi_overbought,
                "trend_filter": p.trend_filter, "max_positions": p.max_positions,
                "risk_per_trade": p.risk_per_trade, "stop_loss_pct": p.stop_loss_pct,
            } for p in all_profiles()
        ],
    }
