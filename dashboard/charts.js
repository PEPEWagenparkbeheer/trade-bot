// Trade Bot Dashboard — multi-profile, dual mode (lokaal/Vercel).

const REFRESH_MS = 30_000;
const PAPER_START = 1000;

const fmtEur = n => '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const fmtPnL = n => (n >= 0 ? '+' : '') + fmtEur(n);
const pnlClass = n => n >= 0 ? 'pnl-pos' : 'pnl-neg';

const sb = window.supabase
    ? window.supabase.createClient(window.BOT_CONFIG.SUPABASE_URL, window.BOT_CONFIG.SUPABASE_ANON_KEY)
    : null;
const LOCAL = window.BOT_CONFIG?.LOCAL ?? true;

// Profielen worden uit /api/status geladen (single source of truth)
let PROFILES = [];           // [{key,label,color,...}]
let MARKET_REGIME = null;    // { is_bull, distance_pct, ma_200, btc_price } — voor 200MA badge
let currentProfileKey = 'gemiddeld';
let activeTab = 'vergelijking';

// Chart instances
let priceChart, rsiChart, portfolioChart, compareChart;

// --- API layer ---
async function api(path, params = {}) {
    if (LOCAL) {
        const url = new URL('/api' + path, location.origin);
        Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && url.searchParams.set(k, v));
        return fetch(url).then(r => r.json());
    }
    return remoteApi(path, params);
}

async function remoteApi(path, params) {
    if (path === '/status') {
        // Hardcoded fallback (matches profiles.py — moet sync blijven).
        // Voor de 200MA marktregime: fetch direct daily BTC candles, bereken inline.
        let market_regime = null;
        try {
            const r = await fetch('https://api.bitvavo.com/v2/BTC-EUR/candles?interval=1d&limit=200');
            const raw = await r.json();
            if (Array.isArray(raw) && raw.length >= 50) {
                // Bitvavo: nieuwste eerst — oudest eerst is duidelijker
                const closes = raw.slice().reverse().map(c => Number(c[4]));
                const ma = closes.reduce((a, b) => a + b, 0) / closes.length;
                const price = closes[closes.length - 1];
                const distance = (price - ma) / ma;
                market_regime = { btc_price: price, ma_200: ma, distance_pct: distance, is_bull: distance > 0.03, buffer_pct: 0.03 };
            }
        } catch (e) { /* niet kritisch */ }
        return {
            env: 'paper', exchange: 'bitvavo',
            pairs: ['BTC/EUR', 'ETH/EUR'],
            rsi_period: 14, paper_capital: 1000,
            market_regime,
            profiles: [
                { key: 'laag',      label: 'Laag',      color: '#22c55e', rsi_oversold: 25, rsi_overbought: 75, trend_filter: 50,  max_positions: 1, risk_per_trade: 0.01, stop_loss_pct: 0.02, use_200ma_filter: false },
                { key: 'gemiddeld', label: 'Gemiddeld', color: '#3b82f6', rsi_oversold: 30, rsi_overbought: 70, trend_filter: 55,  max_positions: 2, risk_per_trade: 0.02, stop_loss_pct: 0.03, use_200ma_filter: false },
                { key: 'hoog',      label: 'Hoog',      color: '#f59e0b', rsi_oversold: 35, rsi_overbought: 65, trend_filter: 60,  max_positions: 3, risk_per_trade: 0.03, stop_loss_pct: 0.04, use_200ma_filter: false },
                { key: 'extreem',   label: 'Extreem',   color: '#ef4444', rsi_oversold: 40, rsi_overbought: 60, trend_filter: null, max_positions: 4, risk_per_trade: 0.05, stop_loss_pct: 0.05, use_200ma_filter: false },
                { key: 'adaptief',  label: 'Adaptief',  color: '#a855f7', rsi_oversold: 20, rsi_overbought: 80, trend_filter: null, max_positions: 4, risk_per_trade: 0.05, stop_loss_pct: 0.05, use_200ma_filter: true  },
            ],
        };
    }
    if (path === '/portfolio') {
        const profile = params.profile;
        const { data: history } = await sb.from('bot_portfolio').select('*').eq('profile', profile).order('snapshot_at', { ascending: false }).limit(200);
        const { data: trades } = await sb.from('bot_trades').select('pnl').eq('profile', profile);
        const realised = (trades || []).reduce((s, t) => s + Number(t.pnl), 0);
        const latest = history?.[0] ? { ...history[0], realised_pnl: realised } : null;
        return { profile, latest, history: history || [], realised_pnl: realised };
    }
    if (path === '/portfolios') {
        const out = [];
        for (const p of PROFILES) {
            const { data: history } = await sb.from('bot_portfolio').select('*').eq('profile', p.key).order('snapshot_at', { ascending: false }).limit(200);
            const { data: trades } = await sb.from('bot_trades').select('pnl').eq('profile', p.key);
            const realised = (trades || []).reduce((s, t) => s + Number(t.pnl), 0);
            const wins = (trades || []).filter(t => Number(t.pnl) > 0).length;
            const latest = history?.[0] ? { ...history[0], realised_pnl: realised } : null;
            out.push({ ...p, latest, history: history || [], trades: (trades || []).length, wins, winrate: (trades || []).length ? wins / trades.length : 0 });
        }
        return { profiles: out };
    }
    if (path === '/positions') {
        const profile = params.profile;
        const q = sb.from('bot_open_positions').select('*');
        const { data: opens } = await (profile ? q.eq('profile', profile) : q);
        const positions = await Promise.all((opens || []).map(async o => {
            const market = o.pair.replace('/', '-');
            let current = Number(o.entry_price);
            try {
                const r = await fetch(`https://api.bitvavo.com/v2/ticker/price?market=${market}`);
                current = Number((await r.json()).price);
            } catch (e) {}
            const entry = Number(o.entry_price), size = Number(o.size);
            return {
                profile: o.profile, pair: o.pair, entry_price: entry, size, stop_loss_price: Number(o.stop_loss_price),
                current_price: current, market_value: size * current,
                unrealised_pnl: size * (current - entry),
                unrealised_pnl_pct: (current - entry) / entry,
                opened_at: o.opened_at,
            };
        }));
        return { positions };
    }
    if (path === '/signals') {
        const q = sb.from('bot_signals').select('*').order('created_at', { ascending: false }).limit(params.limit || 50);
        const { data } = await (params.profile ? q.eq('profile', params.profile) : q);
        return { signals: data || [] };
    }
    if (path === '/trades') {
        const q = sb.from('bot_trades').select('*').order('closed_at', { ascending: false }).limit(params.limit || 50);
        const { data } = await (params.profile ? q.eq('profile', params.profile) : q);
        return { trades: data || [] };
    }
    if (path === '/candles') {
        const market = params.pair.replace('/', '-');
        const r = await fetch(`https://api.bitvavo.com/v2/${market}/candles?interval=${params.timeframe}&limit=${params.limit || 100}`);
        const raw = await r.json();
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
    setupTabs();
    setupProfileSelector();
    setupChartControls();
    setupCardNavigation();
    await refreshAll();
    setInterval(refreshAll, REFRESH_MS);
}

async function loadStatus() {
    const r = await api('/status');
    PROFILES = r.profiles;
    MARKET_REGIME = r.market_regime || null;
    document.getElementById('status-line').textContent =
        `${r.exchange} · ${r.pairs.join(' / ')} · ${PROFILES.length} profielen parallel · €${r.paper_capital} startkapitaal/profiel`;
    document.getElementById('env-badge').textContent = r.env;
}

// 200MA badge HTML voor profielen met use_200ma_filter
function marketRegimeBadge(profile) {
    if (!profile.use_200ma_filter || !MARKET_REGIME || MARKET_REGIME.error) return '';
    const r = MARKET_REGIME;
    const dist = (r.distance_pct * 100).toFixed(1);
    if (r.is_bull) {
        return `<span class="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30" title="BTC ${dist}% boven 200MA — Adaptief pauzeert nieuwe BUY's">⏸ Gepauzeerd</span>`;
    }
    return `<span class="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" title="BTC ${dist}% t.o.v. 200MA — Adaptief handelt normaal">▶ Actief</span>`;
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('tab-active', b === btn));
            document.querySelectorAll('.tab-pane').forEach(pane => {
                pane.classList.toggle('hidden', pane.id !== 'tab-' + activeTab);
            });
            refreshAll();
        });
    });

    // Excel-rapport knop (uit export.js)
    setupXlsxExport();

    // CSV snel-export knoppen
    document.querySelectorAll('[data-export]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const kind = btn.dataset.export;  // 'signals' | 'trades'
            btn.disabled = true;
            try {
                await exportToCsv(kind);
            } catch (e) {
                alert('Export faalde: ' + e.message);
            } finally {
                btn.disabled = false;
            }
        });
    });
}

// --- CSV export ---
async function exportToCsv(kind) {
    const r = await api('/' + kind, { limit: 5000 });
    const rows = r[kind] || [];
    if (!rows.length) { alert('Geen data om te exporteren'); return; }

    // Kolomvolgorde — profile eerst voor leesbaarheid in Excel
    const columnOrder = kind === 'signals'
        ? ['profile', 'created_at', 'pair', 'action', 'price', 'rsi_15m', 'rsi_1h', 'reason']
        : ['profile', 'closed_at', 'opened_at', 'pair', 'entry_price', 'exit_price', 'size', 'pnl', 'reason'];
    const headers = columnOrder.filter(c => c in rows[0]);

    // Semicolon-delimited zodat Excel NL kolommen direct splitst.
    // Decimaalkomma voor numerieke velden zodat Excel NL het als getal pakt.
    const sep = ';';
    const formatCell = (v) => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'number') return String(v).replace('.', ',');
        const s = String(v);
        // Quote als veld separator/quote/newline bevat
        if (s.includes(sep) || s.includes('"') || s.includes('\n')) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    };
    const lines = [headers.join(sep)];
    for (const row of rows) {
        lines.push(headers.map(h => formatCell(row[h])).join(sep));
    }
    // UTF-8 BOM voor correcte weergave van EUR-tekens en accenten in Excel
    const csv = '﻿' + lines.join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade-bot-${kind}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function setupProfileSelector() {
    const sel = document.getElementById('profile-select');
    sel.innerHTML = PROFILES.map(p => `<option value="${p.key}">${p.label}</option>`).join('');
    sel.value = currentProfileKey;
    sel.addEventListener('change', () => {
        currentProfileKey = sel.value;
        updateProfileParams();
        refreshDetailTab();
    });
    updateProfileParams();
}

function updateProfileParams() {
    const p = PROFILES.find(x => x.key === currentProfileKey);
    if (!p) return;
    const tf = p.trend_filter === null ? 'geen' : `<${p.trend_filter}`;
    const maExtra = p.use_200ma_filter ? ' · 200MA-filter aan' : '';
    const badge = marketRegimeBadge(p);
    const el = document.getElementById('profile-params');
    el.innerHTML = `${badge ? badge + ' ' : ''}<span class="text-slate-500">BUY&lt;${p.rsi_oversold} (tf ${tf}) · SELL&gt;${p.rsi_overbought} · max ${p.max_positions} pos · risk ${(p.risk_per_trade * 100).toFixed(0)}% · SL ${(p.stop_loss_pct * 100).toFixed(0)}%${maExtra}</span>`;
    document.getElementById('kpi-open-max').textContent = p.max_positions;
}

function setupChartControls() {
    document.getElementById('chart-pair').addEventListener('change', refreshChart);
    document.getElementById('chart-tf').addEventListener('change', refreshChart);
}

async function refreshAll() {
    if (activeTab === 'vergelijking') {
        await refreshCompareTab();
    } else {
        await refreshDetailTab();
    }
    document.getElementById('last-refresh').textContent =
        `laatste refresh ${new Date().toLocaleTimeString('nl-NL')} · auto elke 30s`;
}

// ============= VERGELIJKING TAB =============

async function refreshCompareTab() {
    const { profiles } = await api('/portfolios');
    drawCompareCards(profiles);
    drawCompareChart(profiles);
    await Promise.all([
        refreshCompareOpenPositions(),
        refreshCompareSignals(),
        refreshCompareTrades(),
    ]);
}

function drawCompareCards(profiles) {
    profiles.forEach(p => {
        const card = document.querySelector(`[data-profile-card="${p.key}"]`);
        if (!card) return;
        const total = p.latest ? Number(p.latest.total_value) : PAPER_START;
        const realised = Number(p.latest?.realised_pnl ?? 0);
        // Floating = total - paper_start - realised   (zie comment hieronder)
        // → splitst het verschil tussen "Total value" en €1000 in realised (gesloten trades)
        //   en floating (mark-to-market van nog open posities). Anders denkt Joep dat PnL
        //   niet klopt omdat realised << (total - 1000).
        const floating = total - PAPER_START - realised;
        const change = (total - PAPER_START) / PAPER_START;
        const tf = p.trend_filter === null ? 'geen' : `<${p.trend_filter}`;
        card.style.borderTopColor = p.color;
        card.style.cursor = 'pointer';
        card.title = 'Klik voor detail-overzicht';
        const regimeBadge = marketRegimeBadge(p);
        card.innerHTML = `
            <div class="flex items-center justify-between mb-1.5 sm:mb-2 gap-1">
                <div class="font-semibold text-sm sm:text-lg truncate" style="color:${p.color}">${p.label}</div>
                <div class="text-[9px] sm:text-[10px] text-slate-500 shrink-0">${p.rsi_oversold}/${p.rsi_overbought}</div>
            </div>
            ${regimeBadge ? `<div class="mb-1.5">${regimeBadge}</div>` : ''}
            <div class="text-base sm:text-2xl font-semibold ${pnlClass(change)} leading-tight">${fmtEur(total)}</div>
            <div class="text-[10px] sm:text-xs ${pnlClass(change)} mb-2 sm:mb-3">${fmtPct(change)}</div>
            <div class="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] sm:text-xs">
                <div><div class="text-slate-500">Realised</div><div class="${pnlClass(realised)} font-medium">${fmtPnL(realised)}</div></div>
                <div><div class="text-slate-500">Floating</div><div class="${pnlClass(floating)} font-medium">${fmtPnL(floating)}</div></div>
                <div><div class="text-slate-500">Trades</div><div class="text-slate-200 font-medium">${p.trades}${p.trades ? ` · ${(p.winrate * 100).toFixed(0)}%` : ''}</div></div>
                <div><div class="text-slate-500">Open</div><div class="text-slate-200 font-medium">${p.latest?.open_positions ?? 0}/${p.max_positions}</div></div>
            </div>
            <div class="hidden sm:block mt-3 pt-3 border-t border-slate-800 text-[10px] text-slate-500">
                risk ${(p.risk_per_trade * 100).toFixed(0)}% · stop ${(p.stop_loss_pct * 100).toFixed(0)}% · tf ${tf}
            </div>
        `;
    });
}

// Click-handler op profile cards → switch naar Detail tab voor dat profiel.
// Geregistreerd één keer in setupTabs(), niet binnen renderloop.
function setupCardNavigation() {
    document.querySelectorAll('[data-profile-card]').forEach(card => {
        card.addEventListener('click', () => {
            const key = card.dataset.profileCard;
            currentProfileKey = key;
            // Update Detail-tab selector
            const sel = document.getElementById('profile-select');
            if (sel) sel.value = key;
            updateProfileParams();
            // Switch tab
            activeTab = 'detail';
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('tab-active', b.dataset.tab === 'detail'));
            document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.toggle('hidden', pane.id !== 'tab-detail'));
            refreshAll();
            // Scroll naar boven
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });
}

// --- Open posities sectie in Vergelijking tab ---
async function refreshCompareOpenPositions() {
    const { positions } = await api('/positions');
    const section = document.getElementById('compare-open-section');
    const list = document.getElementById('compare-open-list');
    const count = document.getElementById('compare-open-count');
    if (!positions || !positions.length) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');
    count.textContent = `(${positions.length})`;
    list.innerHTML = positions.map(p => {
        const pnl = Number(p.unrealised_pnl);
        const pnlPct = Number(p.unrealised_pnl_pct);
        const opened = new Date(p.opened_at).toLocaleString('nl-NL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
        const stopDist = (Number(p.current_price) - Number(p.stop_loss_price)) / Number(p.current_price);
        return `
        <div class="signal-row">
            <div class="flex items-center justify-between gap-2 mb-1.5">
                <div class="flex items-center gap-2 min-w-0">
                    ${profileBadge(p.profile)}
                    <span class="font-semibold">${p.pair}</span>
                </div>
                <div class="${pnlClass(pnl)} font-semibold text-sm">${fmtPnL(pnl)} <span class="text-[10px]">(${fmtPct(pnlPct)})</span></div>
            </div>
            <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-400">
                <div>Entry: <span class="text-slate-200">${fmtEur(p.entry_price)}</span></div>
                <div>Nu: <span class="text-slate-200">${fmtEur(p.current_price)}</span></div>
                <div>Size: <span class="text-slate-200">${Number(p.size).toFixed(6)}</span></div>
                <div>Stop: <span class="text-slate-200">${fmtEur(p.stop_loss_price)}</span> <span class="text-slate-600">(${(stopDist*100).toFixed(1)}%)</span></div>
            </div>
            <div class="text-[9px] text-slate-600 mt-1">geopend ${opened}</div>
        </div>`;
    }).join('');
}

function drawCompareChart(profiles) {
    // Bouw tijdas: pak union van alle snapshot tijden, sorteer.
    const datasets = profiles.map(p => {
        const ordered = [...p.history].reverse();
        return {
            label: p.label,
            data: ordered.map(h => ({ x: new Date(h.snapshot_at), y: Number(h.total_value) })),
            borderColor: p.color,
            backgroundColor: p.color + '20',
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 2,
        };
    });
    if (compareChart) {
        compareChart.data.datasets = datasets;
        compareChart.update('none');
        return;
    }
    compareChart = new Chart(document.getElementById('compareChart'), {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: 'rgb(148 163 184)' } },
                tooltip: {
                    callbacks: { label: ctx => `${ctx.dataset.label}: €${Number(ctx.parsed.y).toLocaleString('nl-NL', { minimumFractionDigits: 2 })}` },
                },
            },
            scales: {
                x: { type: 'time', time: { unit: 'hour' }, ticks: { color: 'rgb(100 116 139)' }, grid: { color: 'rgb(30 41 59 / 0.5)' } },
                y: { ticks: { color: 'rgb(100 116 139)', callback: v => '€' + v }, grid: { color: 'rgb(30 41 59 / 0.5)' } },
            },
        },
    });
}

async function refreshCompareSignals() {
    // Toon 200 zodat scrollen door geschiedenis mogelijk is; tellers staan in headers.
    const { signals } = await api('/signals', { limit: 200 });
    const list = document.getElementById('compare-signals');
    const counter = document.getElementById('compare-signals-count');
    if (counter) counter.textContent = signals.length ? `${signals.length} getoond` : '';
    if (!signals.length) { list.innerHTML = '<div class="text-sm text-slate-500">nog geen signalen</div>'; return; }
    list.innerHTML = signals.map(s => signalRowHtml(s, true)).join('');
}

async function refreshCompareTrades() {
    const { trades } = await api('/trades', { limit: 200 });
    const list = document.getElementById('compare-trades');
    const counter = document.getElementById('compare-trades-count');
    // Breakdown per profiel + outcome
    if (counter) {
        if (!trades.length) {
            counter.textContent = '0 trades';
        } else {
            const wins = trades.filter(t => Number(t.pnl) > 0).length;
            const losses = trades.filter(t => Number(t.pnl) < 0).length;
            counter.textContent = `${trades.length} trades · ${wins} winst · ${losses} verlies`;
        }
    }
    if (!trades.length) { list.innerHTML = '<div class="text-sm text-slate-500">nog geen afgesloten trades</div>'; return; }
    list.innerHTML = trades.map(t => tradeRowHtml(t, true)).join('');
}

function profileBadge(key) {
    const p = PROFILES.find(x => x.key === key);
    if (!p) return '';
    return `<span class="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold" style="background:${p.color}30;color:${p.color}">${p.label.toUpperCase()}</span>`;
}

function signalRowHtml(s, showProfile = false) {
    const klass = s.action === 'BUY' ? 'signal-buy' : s.action === 'SELL' ? 'signal-sell' : 'signal-hold';
    const time = new Date(s.created_at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return `
        <div class="signal-row ${klass}">
            <div class="flex justify-between items-center gap-2">
                <div class="flex items-center gap-2 min-w-0">
                    ${showProfile ? profileBadge(s.profile) : ''}
                    <span class="font-semibold">${s.action}</span>
                    <span class="text-slate-400 text-xs">${s.pair}</span>
                </div>
                <span class="text-xs text-slate-500 shrink-0">${time}</span>
            </div>
            <div class="text-xs text-slate-500 mt-1">RSI 15m=${Number(s.rsi_15m).toFixed(1)} · €${Number(s.price).toLocaleString('nl-NL')}</div>
        </div>`;
}

function tradeRowHtml(t, showProfile = false) {
    const pnl = Number(t.pnl);
    const time = new Date(t.closed_at).toLocaleString('nl-NL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    return `
        <div class="signal-row">
            <div class="flex justify-between items-center gap-2">
                <div class="flex items-center gap-2 min-w-0">
                    ${showProfile ? profileBadge(t.profile) : ''}
                    <div class="font-semibold">${t.pair}</div>
                </div>
                <div class="${pnlClass(pnl)} font-semibold shrink-0">${fmtPnL(pnl)}</div>
            </div>
            <div class="text-xs text-slate-500 mt-1">€${Number(t.entry_price).toLocaleString('nl-NL')} → €${Number(t.exit_price).toLocaleString('nl-NL')} · ${time}</div>
        </div>`;
}

// ============= DETAIL TAB =============

async function refreshDetailTab() {
    await Promise.all([
        refreshDetailPortfolio(),
        refreshDetailPositions(),
        refreshDetailSignals(),
        refreshDetailTrades(),
        refreshChart(),
    ]);
}

async function refreshDetailPortfolio() {
    const r = await api('/portfolio', { profile: currentProfileKey });
    const latest = r.latest;
    if (!latest) {
        document.getElementById('kpi-total').textContent = fmtEur(PAPER_START);
        document.getElementById('kpi-cash').textContent = fmtEur(PAPER_START);
        document.getElementById('kpi-pnl').textContent = fmtPnL(0);
        document.getElementById('kpi-open').textContent = '0';
        return;
    }
    document.getElementById('kpi-total').textContent = fmtEur(latest.total_value);
    document.getElementById('kpi-cash').textContent  = fmtEur(latest.capital);
    document.getElementById('kpi-pnl').textContent   = fmtPnL(latest.realised_pnl);
    document.getElementById('kpi-pnl').className     = 'kpi-value ' + pnlClass(latest.realised_pnl);
    document.getElementById('kpi-open').textContent  = latest.open_positions;

    const change = (latest.total_value - PAPER_START) / PAPER_START;
    const sub = document.getElementById('kpi-total-change');
    sub.textContent = `${fmtPct(change)} vs €${PAPER_START} start`;
    sub.className = 'kpi-sub ' + pnlClass(change);

    drawDetailPortfolioChart(r.history);
}

function drawDetailPortfolioChart(history) {
    const p = PROFILES.find(x => x.key === currentProfileKey);
    const color = p?.color || '#22c55e';
    const ordered = [...history].reverse();
    const labels = ordered.map(h => new Date(h.snapshot_at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }));
    const values = ordered.map(h => Number(h.total_value));
    const ds = {
        label: 'Total value', data: values,
        borderColor: color, backgroundColor: color + '20',
        fill: true, tension: 0.25, pointRadius: 0,
    };
    if (portfolioChart) {
        portfolioChart.data.labels = labels;
        portfolioChart.data.datasets[0] = ds;
        portfolioChart.update('none');
        return;
    }
    portfolioChart = new Chart(document.getElementById('portfolioChart'), {
        type: 'line', data: { labels, datasets: [ds] },
        options: chartBase('€'),
    });
}

async function refreshDetailPositions() {
    const { positions } = await api('/positions', { profile: currentProfileKey });
    const section = document.getElementById('open-positions-section');
    const list = document.getElementById('open-positions-list');
    const count = document.getElementById('open-positions-count');
    if (!positions || !positions.length) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');
    count.textContent = `(${positions.length})`;
    list.innerHTML = positions.map(p => {
        const pnl = Number(p.unrealised_pnl), pnlPct = Number(p.unrealised_pnl_pct);
        const opened = new Date(p.opened_at).toLocaleString('nl-NL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
        const stopDist = (Number(p.current_price) - Number(p.stop_loss_price)) / Number(p.current_price);
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
                <div>Stop: <span class="text-slate-200">${fmtEur(p.stop_loss_price)}</span> <span class="text-slate-600">(${(stopDist*100).toFixed(1)}%)</span></div>
            </div>
            <div class="text-[10px] text-slate-600 mt-1">geopend ${opened}</div>
        </div>`;
    }).join('');
}

async function refreshDetailSignals() {
    const { signals } = await api('/signals', { limit: 200, profile: currentProfileKey });
    const list = document.getElementById('signals-list');
    list.innerHTML = signals.length
        ? signals.map(s => signalRowHtml(s)).join('')
        : '<div class="text-sm text-slate-500">nog geen signalen</div>';
}

async function refreshDetailTrades() {
    const { trades } = await api('/trades', { limit: 200, profile: currentProfileKey });
    const list = document.getElementById('trades-list');
    list.innerHTML = trades.length
        ? trades.map(t => tradeRowHtml(t)).join('')
        : '<div class="text-sm text-slate-500">nog geen afgesloten trades</div>';
}

async function refreshChart() {
    const pair = document.getElementById('chart-pair').value;
    const tf = document.getElementById('chart-tf').value;
    const data = await api('/candles', { pair, timeframe: tf, limit: 100 });

    const labels = data.candles.map(c => new Date(c.timestamp).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }));
    const closes = data.candles.map(c => c.close);
    const rsi = computeRSI(closes, 14);

    if (priceChart) {
        priceChart.data.labels = labels;
        priceChart.data.datasets[0].data = closes;
        priceChart.update('none');
    } else {
        priceChart = new Chart(document.getElementById('priceChart'), {
            type: 'line',
            data: { labels, datasets: [{ label: `${pair} close`, data: closes, borderColor: 'rgb(56 189 248)', backgroundColor: 'rgb(56 189 248 / 0.1)', fill: true, tension: 0.25, pointRadius: 0 }] },
            options: chartBase('€'),
        });
    }
    if (rsiChart) {
        rsiChart.data.labels = labels;
        rsiChart.data.datasets[0].data = rsi;
        rsiChart.update('none');
    } else {
        rsiChart = new Chart(document.getElementById('rsiChart'), {
            type: 'line',
            data: { labels, datasets: [{ label: 'RSI(14)', data: rsi, borderColor: 'rgb(251 191 36)', backgroundColor: 'rgb(251 191 36 / 0.1)', tension: 0.25, pointRadius: 0 }] },
            options: { ...chartBase(''), scales: { ...chartBase('').scales, y: { min: 0, max: 100, ticks: { color: 'rgb(100 116 139)' }, grid: { color: 'rgb(30 41 59 / 0.5)' } } } },
        });
    }
}

function computeRSI(closes, period = 14) {
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

function chartBase(prefix) {
    return {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { labels: { color: 'rgb(148 163 184)' } },
            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${prefix}${Number(ctx.parsed.y).toLocaleString('nl-NL', { maximumFractionDigits: 2 })}` } },
        },
        scales: {
            x: { ticks: { color: 'rgb(100 116 139)', maxRotation: 0, autoSkipPadding: 20 }, grid: { color: 'rgb(30 41 59 / 0.5)' } },
            y: { ticks: { color: 'rgb(100 116 139)' }, grid: { color: 'rgb(30 41 59 / 0.5)' } },
        },
    };
}

// Chart.js needs date adapter for type:'time'. Inline import via CDN.
(function loadDateAdapter() {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js';
    s.onload = () => init();
    document.head.appendChild(s);
})();
