from fastapi import APIRouter

import config
from data.market_filter import market_regime
from profiles import all_profiles

router = APIRouter(prefix="/api", tags=["status"])


@router.get("/status")
def get_status():
    # Markt-regime (200MA filter) — gebruikt door Adaptief-profiel.
    # Frontend toont badge "⏸ Gepauzeerd" / "▶ Actief" op basis hiervan.
    try:
        r = market_regime()
        regime = {
            "btc_price":     r.btc_price,
            "ma_200":        r.ma_200,
            "distance_pct":  r.distance_pct,
            "is_bull":       r.is_bull,
            "buffer_pct":    0.03,
        }
    except Exception as e:
        regime = {"error": str(e)}

    return {
        "env":             config.ENV,
        "exchange":        config.EXCHANGE,
        "pairs":           config.PAIRS,
        "timeframe_entry": config.TIMEFRAME_ENTRY,
        "timeframe_trend": config.TIMEFRAME_TREND,
        "rsi_period":      config.RSI_PERIOD,
        "paper_capital":   1000.0,  # per profiel
        "market_regime":   regime,
        "profiles":        [
            {
                "key": p.key, "label": p.label, "color": p.color,
                "rsi_oversold": p.rsi_oversold, "rsi_overbought": p.rsi_overbought,
                "trend_filter": p.trend_filter, "max_positions": p.max_positions,
                "risk_per_trade": p.risk_per_trade, "stop_loss_pct": p.stop_loss_pct,
                "use_200ma_filter": p.use_200ma_filter,
            } for p in all_profiles()
        ],
    }
