# CLAUDE.md — Trade Bot Project

## Wie ben ik
Joep. Ik leer van nul. Leg altijd kort uit wat je doet en waarom.

## Werkwijze
- Ik zet VS Code aan, jij bouwt
- Voer bash commando's automatisch uit (pip install, mkdir, etc.)
- Maak bestanden direct aan, vraag niet om bevestiging
- Als iets al bestaat, pas het aan — maak het niet opnieuw
- Werk stap voor stap door de bouwvolgorde

## Bouwvolgorde
1. ✅ config
2. ✅ data
3. ✅ strategie
4. ✅ portfolio
5. ✅ engine
6. ✅ api
7. ✅ dashboard

## Stack
- Python 3.12 (geïnstalleerd via winget)
- ccxt (Bybit testnet connectie — Binance werkt niet in NL)
- pandas + pandas_ta (RSI berekening)
- FastAPI + uvicorn (API + dashboard)
- python-dotenv (.env laden)
- supabase (database)

## Trading parameters
- Pairs: BTC/USDT, ETH/USDT
- Timeframe entry: 15m
- Timeframe trend: 1h
- RSI periode: 14
- RSI oversold: 30 (BUY signaal)
- RSI overbought: 70 (SELL signaal)
- Risico per trade: 2%
- Stop loss: 3%
- Paper capital: €1000

## Strategie logica
- LONG: RSI 15m < 30 EN RSI 1h < 50
- EXIT: RSI 15m > 70 OF stop loss geraakt
- HOLD: alles daartussen

## Mappenstructuur
```
trade-bot/
├── CLAUDE.md
├── .env
├── config.py
├── requirements.txt
├── data/
│   ├── fetcher.py
│   ├── indicators.py
│   └── models.py
├── strategy/
│   ├── rsi_strategy.py
│   └── signal.py
├── portfolio/
│   ├── manager.py
│   ├── position.py
│   └── tracker.py
├── engine/
│   ├── bot.py
│   ├── order_executor.py
│   └── logger.py
├── api/
│   ├── main.py
│   ├── db.py
│   └── routes/
│       ├── portfolio.py
│       ├── trades.py
│       ├── signals.py
│       └── candles.py
└── dashboard/
    ├── index.html
    └── charts.js
```

## Supabase tabellen
- trades (id, pair, signal, entry_price, exit_price, pnl, opened_at, closed_at)
- signals (id, pair, signal, rsi_15m, rsi_1h, price, created_at)
- portfolio (id, capital, open_positions, total_pnl, snapshot_at)

## Environment variabelen (.env)
```
BYBIT_TESTNET_API_KEY=    # demo API key (zelfde naam aangehouden)
BYBIT_TESTNET_SECRET=
SUPABASE_URL=
SUPABASE_KEY=
ENV=demo                  # 'demo' (Bybit Demo Trading) of 'live' (echt geld)
EXCHANGE=bybit
```

## Bybit Demo Trading
- Werkt vanaf je live Bybit (EU) account, geen apart testnet-account nodig
- Endpoint: `api-demo.bybit.com` (config.bybit_base_url() levert dit terug)
- Activeer via profielicoon > Demo Trading; genereer demo API key via tab "Demo Trading" in API-overzicht
- Demo gebruikt live marktdata maar gesimuleerde order execution — perfect voor leren

## Skills (installeren bij eerste sessie)
```bash
npx skills add https://github.com/starchild-ai-agent/official-skills --skill coingecko
npx skills add https://github.com/starchild-ai-agent/official-skills --skill backtest
npx skills add https://github.com/starchild-ai-agent/official-skills --skill trading-strategy
```

## Acties die Joep zelf doet (checklist)
- [x] Bybit EU account aangemaakt + KYC standaard
- [ ] Demo Trading mode activeren via profielicoon op bybit.eu
- [ ] Demo API key genereren (profielicoon > API > tab "Demo Trading"), perms: Read + Spot Trade
- [ ] Nieuw Supabase project aanmaken (naam: trade-bot)
- [ ] 3 tabellen aanmaken in Supabase (zie hierboven)
- [ ] SUPABASE_URL + SUPABASE_KEY kopiëren naar .env
- [ ] BYBIT_TESTNET_API_KEY + SECRET kopiëren naar .env (= demo keys)

## Principes
- Geen betaalde APIs — alles gratis totdat de bot winstgevend is
- Strategie en orders zijn gescheiden (strategie geeft alleen signalen)
- API leest alleen uit Supabase, engine schrijft ernaar
- Eerst BTC/USDT + ETH/USDT, altcoins later activeren via config
