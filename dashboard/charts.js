// Trade Bot Dashboard — vanilla JS, geen build step.
// Werkt lokaal (via FastAPI) én op Vercel (direct naar Supabase + Bitvavo).

const REFRESH_MS = 30_000;
const fmtEur = n => '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const fmtPnL = n => (n >= 0 ? '+' : '') + fmtEur(n);
const pnlClass = n => n >= 0 ? 'pnl-pos' : 'pnl-neg';

let priceChart, rsiChart, portfolioChart;
let paperCapital = 1000;

// Supabase client voor remote (Vercel) mode
const sb = window.supabase
    ? window.supabase.createClient(window.BOT_CONFIG.SUPABASE_URL, window.BOT_CONFIG.SUPABASE_ANON_KEY)
    : null;
const LOCAL = window.BOT_CONFIG?.LOCAL ?? true;

// --- API-laag: routeer per omgeving ---
async function api(path, params = {}) {
    if (LOCAL) {
        const url = new URL('/api' + path, location.origin);
        Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
        return fetch(url).then(r => r.json());
    }
    // remote: rechtstreeks naar Supabase/Bitvavo
    return remoteApi(path, params);
}

async function remoteApi(path, params) {
    if (path === '/status') {
        return {
            env: 'paper', exchange: 'bitvavo',
            pairs: ['BTC/EUR','ETH/EUR'],
            rsi_period: 14, rsi_oversold: 30, rsi_overbought: 70,
            risk_per_trade: 0.02, stop_loss_pct: 0.03, paper_capital: 1000,
        };
    }
    if (path === '/portfolio') {
        const { data: history } = await sb.from('bot_portfolio').select('*').order('snapshot_at', { ascending: false }).limit(200);
        const { data: trades } = await sb.from('bot_trades').select('pnl');
        const realised = (trades || []).reduce((s, t) => s + Number(t.pnl), 0);
        const latest = history?.[0] ? { ...history[0], realised_pnl: realised } : null;
        return { latest, history: history || [], realised_pnl: realised };
    }
    if (path === '/positions') {
        const { data: opens } = await sb.from('bot_open_positions').select('*');
        const positions = await Promise.all((opens || []).map(async o => {
            const market = o.pair.replace('/', '-');
            let current = Number(o.entry_price);
            try {
                const r = await fetch(`https://api.bitvavo.com/v2/ticker/price?market=${market}`);
                const j = await r.json();
                current = Number(j.price);
            } catch (e) {}
            const entry = Number(o.entry_price);
            const size = Number(o.size);
            return {
                pair: o.pair, entry_price: entry, size, stop_loss_price: Number(o.stop_loss_price),
                current_price: current, market_value: size * current,
                unrealised_pnl: size * (current - entry),
                unrealised_pnl_pct: (current - entry) / entry,
                opened_at: o.opened_at,
            };
        }));
        return { positions };
    }
    if (path === '/signals') {
        const { data } = await sb.from('bot_signals').select('*').order('created_at', { ascending: false }).limit(params.limit || 50);
        return { signals: data || [] };
    }
    if (path === '/trades') {
        const { data } = await sb.from('bot_trades').select('*').order('closed_at', { ascending: false }).limit(params.limit || 50);
        return { trades: data || [] };
    }
    if (path === '/candles') {
        const market = params.pair.replace('/', '-');
        const r = await fetch(`https://api.bitvavo.com/v2/${market}/candles?interval=${params.timeframe}&limit=${params.limit || 100}`);
        const raw = await r.json();
        // Bitvavo: [timestamp, open, high, low, close, volume], nieuwste eerst — wij willen oudste eerst
        const candles = raw.slice().reverse().map(c => ({
            timestamp: new Date(Number(c[0])).toISOString(),
            open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
        }));
        return { pair: params.pair, timeframe: params.timeframe, candles };
    }
    throw new Error('Onbekend remote path: ' + path);
}

// --- Init ---
async function init() {
    await loadStatus();
    await refreshAll();
    setInterval(refreshAll, REFRESH_MS);

    document.getElementById('chart-pair').addEventListener('change', refreshChart);
    document.getElementById('chart-tf').addEventListener('change', refreshChart);
}

async function loadStatus() {
    const r = await api('/status');
    paperCapital = r.paper_capital;
    document.getElementById('status-line').textContent =
        `${r.exchange} · ${r.pairs.join(' / ')} · RSI ${r.rsi_period} (${r.rsi_oversold}/${r.rsi_overbought}) · risk ${(r.risk_per_trade*100).toFixed(0)}% · SL ${(r.stop_loss_pct*100).toFixed(0)}%`;
    document.getElementById('env-badge').textContent = r.env;
}

async function refreshAll() {
    await Promise.all([
        refreshPortfolio(),
        refreshOpenPositions(),
        refreshSignals(),
        refreshTrades(),
        refreshChart(),
    ]);
    document.getElementById('last-refresh').textContent =
        `laatste refresh ${new Date().toLocaleTimeString('nl-NL')} · auto elke 30s`;
}

// --- Portfolio ---
async function refreshPortfolio() {
    const { latest, history } = await api('/portfolio');
    if (!latest) return;

    document.getElementById('kpi-total').textContent = fmtEur(latest.total_value);
    document.getElementById('kpi-cash').textContent  = fmtEur(latest.capital);
    document.getElementById('kpi-pnl').textContent   = fmtPnL(latest.realised_pnl);
    document.getElementById('kpi-pnl').className     = 'kpi-value ' + pnlClass(latest.realised_pnl);
    document.getElementById('kpi-open').textContent  = latest.open_positions;

    const change = (latest.total_value - paperCapital) / paperCapital;
    const sub = document.getElementById('kpi-total-change');
    sub.textContent = `${fmtPct(change)} vs ${fmtEur(paperCapital)} start`;
    sub.className = 'kpi-sub ' + pnlClass(change);

    drawPortfolioChart(history);
}

function drawPortfolioChart(history) {
    const ordered = [...history].reverse();
    const labels = ordered.map(h => new Date(h.snapshot_at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }));
    const values = ordered.map(h => Number(h.total_value));

    if (portfolioChart) {
        portfolioChart.data.labels = labels;
        portfolioChart.data.datasets[0].data = values;
        portfolioChart.update('none');
        return;
    }
    portfolioChart = new Chart(document.getElementById('portfolioChart'), {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Total value',
                data: values,
                borderColor: 'rgb(52 211 153)',
                backgroundColor: 'rgb(52 211 153 / 0.1)',
                fill: true,
                tension: 0.25,
                pointRadius: 0,
            }],
        },
        options: chartBase('€'),
    });
}

// --- Open posities ---
async function refreshOpenPositions() {
    const { positions } = await api('/positions');
    const section = document.getElementById('open-positions-section');
    const list = document.getElementById('open-positions-list');
    const count = document.getElementById('open-positions-count');
    if (!positions || positions.length === 0) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');
    count.textContent = `(${positions.length})`;
    list.innerHTML = positions.map(p => {
        const pnl = Number(p.unrealised_pnl);
        const pnlPct = Number(p.unrealised_pnl_pct);
        const opened = new Date(p.opened_at).toLocaleString('nl-NL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
        const stopDistPct = (Number(p.current_price) - Number(p.stop_loss_price)) / Number(p.current_price);
        return `
        <div class="signal-row">
            <div class="flex justify-between items-baseline">
                <div class="font-semibold text-base">${p.pair}</div>
                <div class="${pnlClass(pnl)} font-semibold text-base">${fmtPnL(pnl)} <span class="text-xs">(${fmtPct(pnlPct)})</span></div>
            </div>
            <div class="grid grid-cols-2 gap-1 mt-2 text-xs text-slate-400">
                <div>Size: <span class="text-slate-200">${Number(p.size).toFixed(6)}</span></div>
                <div>Entry: <span class="text-slate-200">${fmtEur(p.entry_price)}</span></div>
                <div>Nu: <span class="text-slate-200">${fmtEur(p.current_price)}</span></div>
                <div>Stop: <span class="text-slate-200">${fmtEur(p.stop_loss_price)}</span> <span class="text-slate-600">(${(stopDistPct*100).toFixed(1)}%)</span></div>
            </div>
            <div class="text-[10px] text-slate-600 mt-1">geopend ${opened}</div>
        </div>`;
    }).join('');
}

// --- Signals feed ---
async function refreshSignals() {
    const { signals } = await api('/signals', { limit: 30 });
    const list = document.getElementById('signals-list');
    if (!signals.length) { list.innerHTML = '<div class="text-sm text-slate-500">nog geen signalen</div>'; return; }
    list.innerHTML = signals.map(s => {
        const klass = s.action === 'BUY' ? 'signal-buy' : s.action === 'SELL' ? 'signal-sell' : 'signal-hold';
        const time = new Date(s.created_at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
        return `
        <div class="signal-row ${klass}">
            <div class="flex justify-between items-center">
                <div>
                    <span class="font-semibold">${s.action}</span>
                    <span class="text-slate-400 text-xs ml-2">${s.pair}</span>
                </div>
                <span class="text-xs text-slate-500">${time}</span>
            </div>
            <div class="text-xs text-slate-500 mt-1">
                RSI 15m=${Number(s.rsi_15m).toFixed(1)} · 1h=${Number(s.rsi_1h).toFixed(1)} · €${Number(s.price).toLocaleString('nl-NL')}
            </div>
            <div class="text-xs text-slate-600 mt-0.5 italic">${s.reason}</div>
        </div>`;
    }).join('');
}

// --- Trades ---
async function refreshTrades() {
    const { trades } = await api('/trades', { limit: 30 });
    const list = document.getElementById('trades-list');
    if (!trades.length) { list.innerHTML = '<div class="text-sm text-slate-500">nog geen afgesloten trades</div>'; return; }
    list.innerHTML = trades.map(t => {
        const pnl = Number(t.pnl);
        const time = new Date(t.closed_at).toLocaleString('nl-NL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
        return `
        <div class="signal-row">
            <div class="flex justify-between">
                <div class="font-semibold">${t.pair}</div>
                <div class="${pnlClass(pnl)} font-semibold">${fmtPnL(pnl)}</div>
            </div>
            <div class="text-xs text-slate-500 mt-1">
                ${Number(t.size).toFixed(6)} @ €${Number(t.entry_price).toLocaleString('nl-NL')} → €${Number(t.exit_price).toLocaleString('nl-NL')}
            </div>
            <div class="text-xs text-slate-600 mt-0.5">${t.reason} · ${time}</div>
        </div>`;
    }).join('');
}

// --- Price + RSI chart ---
async function refreshChart() {
    const pair = document.getElementById('chart-pair').value;
    const tf = document.getElementById('chart-tf').value;
    const data = await api('/candles', { pair, timeframe: tf, limit: 100 });

    const labels = data.candles.map(c => new Date(c.timestamp).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }));
    const closes = data.candles.map(c => c.close);
    const rsi = computeRSI(closes, 14);

    // Price chart
    if (priceChart) {
        priceChart.data.labels = labels;
        priceChart.data.datasets[0].data = closes;
        priceChart.update('none');
    } else {
        priceChart = new Chart(document.getElementById('priceChart'), {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: `${pair} close`,
                    data: closes,
                    borderColor: 'rgb(56 189 248)',
                    backgroundColor: 'rgb(56 189 248 / 0.1)',
                    fill: true,
                    tension: 0.25,
                    pointRadius: 0,
                }],
            },
            options: chartBase('€'),
        });
    }

    // RSI chart
    if (rsiChart) {
        rsiChart.data.labels = labels;
        rsiChart.data.datasets[0].data = rsi;
        rsiChart.update('none');
    } else {
        rsiChart = new Chart(document.getElementById('rsiChart'), {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'RSI(14)',
                    data: rsi,
                    borderColor: 'rgb(251 191 36)',
                    backgroundColor: 'rgb(251 191 36 / 0.1)',
                    fill: false,
                    tension: 0.25,
                    pointRadius: 0,
                }],
            },
            options: {
                ...chartBase(''),
                scales: {
                    ...chartBase('').scales,
                    y: {
                        min: 0, max: 100,
                        ticks: { color: 'rgb(100 116 139)' },
                        grid: { color: 'rgb(30 41 59 / 0.5)' },
                    },
                },
                plugins: {
                    ...chartBase('').plugins,
                    annotation: undefined,
                },
            },
        });
    }
}

// Wilder RSI (zelfde formule als backend) — voor live chart overlay
function computeRSI(closes, period = 14) {
    if (closes.length < period + 1) return closes.map(() => null);
    const out = new Array(closes.length).fill(null);
    const alpha = 1 / period;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i-1];
        avgGain += Math.max(d, 0);
        avgLoss += Math.max(-d, 0);
    }
    avgGain /= period; avgLoss /= period;
    out[period] = 100 - 100 / (1 + (avgGain / (avgLoss || 1e-10)));
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i-1];
        const g = Math.max(d, 0), l = Math.max(-d, 0);
        avgGain = (1 - alpha) * avgGain + alpha * g;
        avgLoss = (1 - alpha) * avgLoss + alpha * l;
        out[i] = 100 - 100 / (1 + (avgGain / (avgLoss || 1e-10)));
    }
    return out;
}

function chartBase(prefix) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { labels: { color: 'rgb(148 163 184)' } },
            tooltip: { callbacks: {
                label: ctx => `${ctx.dataset.label}: ${prefix}${Number(ctx.parsed.y).toLocaleString('nl-NL', { maximumFractionDigits: 2 })}`,
            }},
        },
        scales: {
            x: { ticks: { color: 'rgb(100 116 139)', maxRotation: 0, autoSkipPadding: 20 }, grid: { color: 'rgb(30 41 59 / 0.5)' } },
            y: { ticks: { color: 'rgb(100 116 139)' }, grid: { color: 'rgb(30 41 59 / 0.5)' } },
        },
    };
}

init();
