"""
Centrale config voor de trade-bot.
Laadt .env in en stelt alle constanten ter beschikking aan de rest van de code.
"""
from pathlib import Path
from dotenv import load_dotenv
import os

# .env inladen vanuit projectroot (zelfde map als dit bestand)
ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")


# --- Secrets uit .env ---------------------------------------------------------
BITVAVO_API_KEY = os.getenv("BITVAVO_API_KEY", "")
BITVAVO_SECRET = os.getenv("BITVAVO_SECRET", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
ENV = os.getenv("ENV", "paper").lower()
EXCHANGE = os.getenv("EXCHANGE", "bitvavo").lower()


# --- Trading parameters -------------------------------------------------------
# Bitvavo handelt voornamelijk in EUR-pairs (NL exchange)
PAIRS = ["BTC/EUR", "ETH/EUR"]
TIMEFRAME_ENTRY = "15m"
TIMEFRAME_TREND = "1h"

# RSI — drempels kunnen via .env overschreven worden
RSI_PERIOD = int(os.getenv("RSI_PERIOD", 14))
RSI_OVERSOLD = float(os.getenv("RSI_OVERSOLD", 40))      # < drempel → BUY signaal (40 = agressief, 30 = conservatief)
RSI_OVERBOUGHT = float(os.getenv("RSI_OVERBOUGHT", 60))  # > drempel → SELL signaal (60 = agressief, 70 = conservatief)
RSI_TREND_FILTER = float(os.getenv("RSI_TREND_FILTER", 55))  # 1h RSI < drempel = downtrend filter voor LONG entries

# Risk management
RISK_PER_TRADE = 0.02   # 2% van portfolio per trade
STOP_LOSS_PCT = 0.03    # 3% stop loss
PAPER_CAPITAL = 1000.0  # startkapitaal in EUR (papertrading)


# --- Helpers ------------------------------------------------------------------
def is_paper() -> bool:
    return ENV == "paper"


def assert_secrets() -> None:
    """
    Crasht vroeg als kritieke env vars ontbreken.
    In paper-modus zijn exchange-keys NIET vereist (public data is open).
    """
    required = {
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_ANON_KEY": SUPABASE_ANON_KEY,
        "SUPABASE_SERVICE_KEY": SUPABASE_SERVICE_KEY,
    }
    if not is_paper():
        required["BITVAVO_API_KEY"] = BITVAVO_API_KEY
        required["BITVAVO_SECRET"] = BITVAVO_SECRET

    missing = [k for k, v in required.items() if not v]
    if missing:
        raise RuntimeError(
            f"Missende env vars: {', '.join(missing)}. Vul .env aan."
        )


if __name__ == "__main__":
    # Snelle smoke test: `python config.py`
    print(f"ENV={ENV}  EXCHANGE={EXCHANGE}")
    print(f"PAIRS={PAIRS}  entry={TIMEFRAME_ENTRY}  trend={TIMEFRAME_TREND}")
    print(f"RSI period={RSI_PERIOD}  oversold={RSI_OVERSOLD}  overbought={RSI_OVERBOUGHT}")
    print(f"Risk per trade={RISK_PER_TRADE*100}%  SL={STOP_LOSS_PCT*100}%")
    print(f"Paper capital=EUR {PAPER_CAPITAL}")
    check_keys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"] if is_paper() else \
                 ["BITVAVO_API_KEY", "BITVAVO_SECRET", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"]
    missing = [k for k in check_keys if not os.getenv(k)]
    print(f"Missende secrets ({'paper' if is_paper() else 'live'} mode): {missing if missing else 'geen'}")
