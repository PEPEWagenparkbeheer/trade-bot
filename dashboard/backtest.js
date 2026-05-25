// Backtest runner — browser-side simulator van de RSI-strategie op historische
// Bitvavo candles. Geen backend nodig, draait overal (lokaal + Vercel).
//
// Hergebruikt PROFILES + computeRSI van charts.js.

// ============================================================================
// Historische candles ophalen (Bitvavo, gechunked voor lange periodes)
// ============================================================================

const TF_MS = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

async function fetchHistoricalCandles(pair, timeframe, sinceMs, untilMs, progressCb = null) {
    // Bitvavo levert max 1440 candles per call. Voor langere periodes paginated.
    // Safety = 300 → genoeg voor ~12 jaar op 15m of veel meer op grovere TF's.
    // Progress callback (optional): wordt aangeroepen per chunk met { pair, tf, loaded, oldestIso }.
    const market = pair.replace('/', '-');
    const tfMs = TF_MS[timeframe];
    if (!tfMs) throw new Error('Onbekend timeframe: ' + timeframe);

    const allCandles = [];
    let cursorEnd = untilMs;
    let safety = 0;
    const MAX_CHUNKS = 300;

    while (cursorEnd > sinceMs && safety < MAX_CHUNKS) {
        safety++;
        const url = `https://api.bitvavo.com/v2/${market}/candles?interval=${timeframe}&limit=1440&end=${cursorEnd}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Bitvavo ${pair} ${timeframe}: HTTP ${r.status}`);
        const raw = await r.json();
        if (!raw.length) break;

        // Bitvavo: nieuwste eerst — we willen oudste eerst
        const chunk = raw.map(c => ({
            timestamp: Number(c[0]),
            open:  Number(c[1]),
            high:  Number(c[2]),
            low:   Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5]),
        })).filter(c => c.timestamp >= sinceMs);

        // Sorteer chronologisch + prepend (we werken backward in tijd)
        chunk.sort((a, b) => a.timestamp - b.timestamp);
        allCandles.unshift(...chunk);

        if (progressCb) {
            const oldestIso = chunk[0] ? new Date(chunk[0].timestamp).toISOString().slice(0, 10) : '';
            progressCb({ pair, tf: timeframe, loaded: allCandles.length, oldestIso, chunks: safety });
        }

        const oldestInChunk = chunk[0]?.timestamp ?? cursorEnd;
        if (oldestInChunk <= sinceMs || chunk.length < 1440) break;
        cursorEnd = oldestInChunk - tfMs;
    }

    // Dedupe op timestamp + sorteer
    const dedup = new Map();
    for (const c of allCandles) dedup.set(c.timestamp, c);
    return [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// ============================================================================
// 200-daags MA filter (voor Adaptief-profiel)
// ============================================================================

// Rolling simple moving average. Returns array met null tot index window-1.
function rollingMA(values, window) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= window) sum -= values[i - window];
        if (i >= window - 1) out[i] = sum / window;
    }
    return out;
}

// Bouw market-context object dat door runBacktest gebruikt wordt voor:
// - V1 isBullAt(): bull-check met 3% buffer (Adaptief)
// - V2 regimeAt(): "bear"/"neutral"/"bull" met ±10% drempels (Adaptief V2)
function buildMarketContext(btcDaily, buffer = 0.03, regimeThreshold = 0.10, slopeLagDays = 10) {
    const closes = btcDaily.map(c => c.close);
    const timestamps = btcDaily.map(c => c.timestamp);
    const ma200 = rollingMA(closes, 200);
    return {
        timestamps, closes, ma200, buffer, regimeThreshold, slopeLagDays,
        indexAt(t) {
            let lo = 0, hi = this.timestamps.length - 1, ans = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (this.timestamps[mid] <= t) { ans = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            return ans;
        },
        distanceAt(t) {
            const i = this.indexAt(t);
            if (i < 0 || this.ma200[i] == null) return null;
            return (this.closes[i] - this.ma200[i]) / this.ma200[i];
        },
        slopeAt(t) {
            // MA(today) - MA(N dagen geleden) in EUR; positief = stijgend
            const i = this.indexAt(t);
            const j = i - this.slopeLagDays;
            if (i < 0 || j < 0 || this.ma200[i] == null || this.ma200[j] == null) return 0;
            return this.ma200[i] - this.ma200[j];
        },
        isBullAt(t) {
            const d = this.distanceAt(t);
            return d != null && d > this.buffer;
        },
        regimeAt(t) {
            const d = this.distanceAt(t);
            if (d == null) return null;
            if (d > this.regimeThreshold)  return 'bull';
            if (d < -this.regimeThreshold) return 'bear';
            return 'neutral';
        },
        // V3: slope-aware 4-state classificatie
        regimeV3At(t) {
            const d = this.distanceAt(t);
            if (d == null) return null;
            if (d > this.regimeThreshold) return 'above-far';
            if (d >= 0) return 'above-close';
            const s = this.slopeAt(t);
            return s < 0 ? 'bear-falling' : 'bear-rising';
        },
    };
}

// ============================================================================
// RSI (Wilder) — incrementeel berekend over een array close-prijzen
// ============================================================================

function rsiSeries(closes, period = 14) {
    if (closes.length < period + 1) return closes.map(() => null);
    const out = new Array(closes.length).fill(null);
    const alpha = 1 / period;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain += Math.max(d, 0); avgLoss += Math.max(-d, 0);
    }
    avgGain /= period; avgLoss /= period;
    out[period] = 100 - 100 / (1 + (avgGain / (avgLoss || 1e-10)));
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        const g = Math.max(d, 0), l = Math.max(-d, 0);
        avgGain = (1 - alpha) * avgGain + alpha * g;
        avgLoss = (1 - alpha) * avgLoss + alpha * l;
        out[i] = 100 - 100 / (1 + (avgGain / (avgLoss || 1e-10)));
    }
    return out;
}

// ============================================================================
// Paper portfolio — gelijkwaardige port van portfolio/manager.py
// ============================================================================

class PaperPortfolio {
    constructor(profile, startCap = 1000) {
        this.profile = profile;
        this.cash = startCap;
        this.startCap = startCap;
        this.positions = new Map();   // pair -> { entry, size, stop, openedAt }
        this.trades = [];
        this.equity = [];             // [{ t, value }]
        this.peakValue = startCap;
        this.maxDrawdown = 0;
    }
    atMax() { return this.positions.size >= this.profile.max_positions; }
    canOpen(pair) { return !this.positions.has(pair) && !this.atMax() && this.cash > 0; }

    openLong(pair, price, timestamp) {
        if (!this.canOpen(pair)) return null;
        const riskEur = this.cash * this.profile.risk_per_trade;
        let posEur = riskEur / this.profile.stop_loss_pct;
        if (posEur > this.cash) posEur = this.cash;
        if (posEur <= 0) return null;
        const size = posEur / price;
        const stop = price * (1 - this.profile.stop_loss_pct);
        const pos = { pair, entry: price, size, stop, openedAt: timestamp };
        this.positions.set(pair, pos);
        this.cash -= size * price;
        return pos;
    }

    close(pair, exitPrice, timestamp, reason) {
        const pos = this.positions.get(pair);
        if (!pos) return null;
        this.positions.delete(pair);
        const proceeds = pos.size * exitPrice;
        const pnl = proceeds - pos.size * pos.entry;
        this.cash += proceeds;
        const trade = {
            pair, entry: pos.entry, exit: exitPrice, size: pos.size,
            pnl, pnlPct: (exitPrice - pos.entry) / pos.entry,
            openedAt: pos.openedAt, closedAt: timestamp,
            durationMs: timestamp - pos.openedAt,
            reason,
        };
        this.trades.push(trade);
        return trade;
    }

    totalValue(prices) {
        let mv = 0;
        for (const [pair, pos] of this.positions) mv += pos.size * (prices[pair] ?? pos.entry);
        return this.cash + mv;
    }

    recordEquity(timestamp, prices) {
        const v = this.totalValue(prices);
        this.equity.push({ t: timestamp, value: v });
        if (v > this.peakValue) this.peakValue = v;
        const dd = (this.peakValue - v) / this.peakValue;
        if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    }
}

// ============================================================================
// Strategie-decide (port van strategy.rsi_strategy._decide)
// ============================================================================

function decide(rsi15m, rsi1h, profile, regime = null, regimeV3 = null) {
    let os = profile.rsi_oversold;
    let ob = profile.rsi_overbought;
    // V3 (slope-aware, 4 regimes) — neemt voorrang als profiel V3 gebruikt
    if (profile.use_slope_filter && regimeV3) {
        if (regimeV3 === 'above-far') return 'HOLD';
        const map = {
            'bear-falling': profile.regime_bear_falling,
            'bear-rising':  profile.regime_bear_rising,
            'above-close':  profile.regime_above_close,
        };
        const t = map[regimeV3];
        if (t) [os, ob] = t;
    } else if (profile.use_regime_filter && regime) {
        if (regime === 'bull') return 'HOLD';
        if (regime === 'bear' && profile.regime_bear) [os, ob] = profile.regime_bear;
        if (regime === 'neutral' && profile.regime_neutral) [os, ob] = profile.regime_neutral;
    }
    const trendOk = profile.trend_filter == null || rsi1h < profile.trend_filter;
    if (rsi15m < os && trendOk) return 'BUY';
    if (rsi15m > ob) return 'SELL';
    return 'HOLD';
}

// ============================================================================
// Backtest runner: multi-pair, single profile
// ============================================================================

function runBacktest(profile, candlesByPair, candles1hByPair, startCap = 1000, marketContext = null) {
    const pp = new PaperPortfolio(profile, startCap);
    let pausedBuys = 0;   // hoeveel BUY-signalen genegeerd door 200MA filter

    // Pre-compute RSI per pair
    const rsi15mByPair = {};
    const rsi1hByPair = {};
    for (const [pair, candles] of Object.entries(candlesByPair)) {
        rsi15mByPair[pair] = rsiSeries(candles.map(c => c.close), 14);
    }
    for (const [pair, candles] of Object.entries(candles1hByPair)) {
        rsi1hByPair[pair] = rsiSeries(candles.map(c => c.close), 14);
    }

    // Build unified timeline: union van alle 15m timestamps over pairs.
    const timestampSet = new Set();
    for (const candles of Object.values(candlesByPair)) {
        for (const c of candles) timestampSet.add(c.timestamp);
    }
    const timestamps = [...timestampSet].sort((a, b) => a - b);

    // Per pair: index lookup voor 15m + 1h
    const idx15m = {};
    const idx1h = {};
    for (const pair of Object.keys(candlesByPair)) {
        idx15m[pair] = new Map(candlesByPair[pair].map((c, i) => [c.timestamp, i]));
        idx1h[pair] = candles1hByPair[pair].map(c => c.timestamp);
    }

    function find1hIndexAt(pair, t) {
        const list = idx1h[pair];
        // binary search rightmost <= t
        let lo = 0, hi = list.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid] <= t) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return ans;
    }

    let opens = 0, sells = 0, stops = 0;

    for (const t of timestamps) {
        const prices = {};
        // Verzamel huidige prijs per pair (laatste bekende t.o.v. t)
        for (const pair of Object.keys(candlesByPair)) {
            const i = idx15m[pair].get(t);
            if (i !== undefined) prices[pair] = candlesByPair[pair][i].close;
        }

        // Stop loss check eerst voor alle open posities
        for (const [pair, pos] of [...pp.positions]) {
            const price = prices[pair];
            if (price !== undefined && price <= pos.stop) {
                pp.close(pair, price, t, 'stop-loss');
                stops++;
            }
        }

        // Evalueer per pair
        for (const pair of Object.keys(candlesByPair)) {
            const i = idx15m[pair].get(t);
            if (i === undefined) continue;
            const r15 = rsi15mByPair[pair][i];
            if (r15 == null) continue;
            const h1i = find1hIndexAt(pair, t);
            if (h1i < 0) continue;
            const r1h = rsi1hByPair[pair][h1i];
            if (r1h == null) continue;

            const regime   = (profile.use_regime_filter && marketContext) ? marketContext.regimeAt(t) : null;
            const regimeV3 = (profile.use_slope_filter  && marketContext) ? marketContext.regimeV3At(t) : null;
            const action = decide(r15, r1h, profile, regime, regimeV3);
            const price = prices[pair];
            if (action === 'BUY') {
                // V1 200MA marktfilter: pauzeer BUY's tijdens bull market (alleen Adaptief V1)
                if (profile.use_200ma_filter && marketContext && marketContext.isBullAt(t)) {
                    pausedBuys++;
                    continue;
                }
                if (pp.openLong(pair, price, t)) opens++;
            } else if (action === 'SELL') {
                if (pp.close(pair, price, t, 'sell-signal')) sells++;
            }
            // V2 telt 'HOLD-bij-bull' al impliciet via decide() → niet apart loggen
        }

        pp.recordEquity(t, prices);
    }

    // Sluit alle nog open posities op de laatste prijs voor schone eindstand
    const lastT = timestamps[timestamps.length - 1];
    const lastPrices = {};
    for (const pair of Object.keys(candlesByPair)) {
        const arr = candlesByPair[pair];
        lastPrices[pair] = arr[arr.length - 1].close;
    }
    for (const [pair] of [...pp.positions]) {
        pp.close(pair, lastPrices[pair], lastT, 'backtest-end');
    }
    pp.recordEquity(lastT, {});

    const stats = computeStats(pp, lastPrices, opens, sells, stops);
    stats.pausedBuys = pausedBuys;
    return {
        profile,
        startCap,
        finalValue: pp.totalValue({}),
        trades: pp.trades,
        equity: pp.equity,
        stats,
    };
}

function computeStats(pp, lastPrices, opens, sells, stops) {
    const trades = pp.trades;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 && losses.length
        ? Math.abs(avgWin * wins.length) / Math.abs(avgLoss * losses.length)
        : (wins.length ? Infinity : 0);
    const avgDuration = trades.length ? trades.reduce((s, t) => s + t.durationMs, 0) / trades.length / 60_000 : 0;
    const finalValue = pp.totalValue({});  // alles is gesloten
    return {
        finalValue,
        totalReturn: (finalValue - pp.startCap) / pp.startCap,
        totalPnl,
        totalTrades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winrate: trades.length ? wins.length / trades.length : 0,
        avgWin, avgLoss, profitFactor,
        maxWin: wins.length ? Math.max(...wins.map(t => t.pnl)) : 0,
        maxLoss: losses.length ? Math.min(...losses.map(t => t.pnl)) : 0,
        maxDrawdown: pp.maxDrawdown,
        avgDurationMin: avgDuration,
        opens, sells, stops,
    };
}

// ============================================================================
// Buy-and-hold benchmark — koop EUR 1000 per pair op tick 1, hold tot eind
// ============================================================================

function buyAndHold(candlesByPair, startCap = 1000) {
    const pairs = Object.keys(candlesByPair);
    const allocPerPair = startCap / pairs.length;
    const sizes = {};
    const firstPrices = {};
    for (const pair of pairs) {
        firstPrices[pair] = candlesByPair[pair][0].close;
        sizes[pair] = allocPerPair / firstPrices[pair];
    }
    // Equity curve = union timestamps, value op elk moment
    const tsSet = new Set();
    for (const c of Object.values(candlesByPair)) for (const x of c) tsSet.add(x.timestamp);
    const ts = [...tsSet].sort((a, b) => a - b);
    const lastPrice = { ...firstPrices };
    const idx = {};
    for (const pair of pairs) idx[pair] = new Map(candlesByPair[pair].map((c, i) => [c.timestamp, i]));
    const equity = [];
    for (const t of ts) {
        for (const pair of pairs) {
            const i = idx[pair].get(t);
            if (i !== undefined) lastPrice[pair] = candlesByPair[pair][i].close;
        }
        const v = pairs.reduce((s, p) => s + sizes[p] * lastPrice[p], 0);
        equity.push({ t, value: v });
    }
    const finalValue = equity[equity.length - 1].value;
    return {
        equity, finalValue, totalReturn: (finalValue - startCap) / startCap,
    };
}

// ============================================================================
// Threshold optimizer — grid scan over RSI drempels
// ============================================================================

function optimizeThresholds(baseProfile, candlesByPair, candles1hByPair, grid) {
    // grid = { oversold: [25,30,35,40,45], overbought: [55,60,65,70,75] }
    const results = [];
    for (const os of grid.oversold) {
        for (const ob of grid.overbought) {
            if (ob <= os) continue;  // overbought moet > oversold zijn
            const variant = { ...baseProfile, rsi_oversold: os, rsi_overbought: ob };
            const r = runBacktest(variant, candlesByPair, candles1hByPair, 1000);
            results.push({
                oversold: os, overbought: ob,
                return: r.stats.totalReturn,
                trades: r.stats.totalTrades,
                winrate: r.stats.winrate,
                maxDrawdown: r.stats.maxDrawdown,
                profitFactor: r.stats.profitFactor,
                finalValue: r.stats.finalValue,
            });
        }
    }
    results.sort((a, b) => b.return - a.return);
    return results;
}

// ============================================================================
// Top-N alternatieve drempels — grid scan, exclude bestaande profielen
// ============================================================================

function findTopAlternatives(base, candlesByPair, candles1hByPair, excludeCombos, topN = 3, startCap = 1000, gridSize = 'medium') {
    // Grid adapteert aan dataset-grootte: bij langere periodes minder combinaties
    // omdat elke variant een hele backtest doet (~50ms per 1k candles).
    const grids = {
        fine: {
            oversold:   [20, 23, 25, 27, 30, 33, 35, 37, 40, 43],
            overbought: [55, 57, 60, 63, 65, 67, 70, 73, 75, 78, 80],
        },
        medium: {
            oversold:   [20, 25, 30, 35, 40, 45],
            overbought: [55, 60, 65, 70, 75, 80],
        },
        coarse: {
            oversold:   [22, 30, 38],
            overbought: [62, 70, 78],
        },
    };
    const grid = grids[gridSize] || grids.medium;
    const excludeSet = new Set(excludeCombos.map(c => `${c.os}-${c.ob}`));

    const all = [];
    for (const os of grid.oversold) {
        for (const ob of grid.overbought) {
            if (ob <= os + 5) continue;        // zinvolle spread
            if (excludeSet.has(`${os}-${ob}`)) continue;
            const variant = {
                ...base,
                key: `alt-${os}-${ob}`,
                label: `Alt ${os}/${ob}`,
                rsi_oversold: os,
                rsi_overbought: ob,
            };
            const r = runBacktest(variant, candlesByPair, candles1hByPair, startCap);
            all.push({ profile: variant, ...r });
        }
    }
    all.sort((a, b) => b.stats.totalReturn - a.stats.totalReturn);
    return all.slice(0, topN);
}

// Expose globaal voor charts.js
window.Backtest = {
    fetchHistoricalCandles,
    runBacktest,
    buyAndHold,
    optimizeThresholds,
    findTopAlternatives,
    rsiSeries,
    decide,
    rollingMA,
    buildMarketContext,
};
