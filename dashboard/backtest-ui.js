// Backtest UI — koppelt het form aan de runner in backtest.js,
// rendert KPI-tabel, equity curve en optimizer ranking.

let btLastResults = null;       // [{profile, ...result}, ...]   — 4 echte profielen
let btLastAlternatives = null;  // top 3 wat-als profielen met volledige equity
let btLastBuyHold = null;
let btLastCandles = null;       // { candlesByPair, candles1hByPair }
let btLastOpt = null;           // optimizer rijen
let btEquityChart = null;

const BT_COLORS = {
    laag: '#22c55e', gemiddeld: '#3b82f6', hoog: '#f59e0b', extreem: '#ef4444',
    'buy-hold': '#94a3b8',     // grijs (was paars; paars gebruikt nu voor alternatives)
};
// Pastel/fuchsia tinten voor "wat als" lijnen — staan visueel naast de 4 base kleuren
const BT_ALT_COLORS = ['#ec4899', '#a855f7', '#06b6d4'];

function setBtStatus(msg) { document.getElementById('bt-status').textContent = msg; }
function setBtOptStatus(msg) { document.getElementById('bt-opt-status').textContent = msg; }

document.addEventListener('DOMContentLoaded', () => {
    // Wacht tot PROFILES geladen zijn — init.js (charts.js) doet dat in init()
    setTimeout(setupBacktestUI, 200);
});

function setupBacktestUI() {
    document.getElementById('bt-run').addEventListener('click', runBacktestUI);
    document.getElementById('bt-optimize').addEventListener('click', runOptimizerUI);
    document.getElementById('bt-export').addEventListener('click', exportBacktestResults);

    // Toggle custom date range bij periode=custom
    const periodSel = document.getElementById('bt-period');
    const customBox = document.getElementById('bt-custom-dates');
    const dateFrom = document.getElementById('bt-date-from');
    const dateTo = document.getElementById('bt-date-to');
    periodSel.addEventListener('change', () => {
        const isCustom = periodSel.value === 'custom';
        customBox.classList.toggle('hidden', !isCustom);
        if (isCustom && !dateFrom.value) {
            // Default: laatste 30 dagen, eindigend vandaag
            const today = new Date();
            const past = new Date(Date.now() - 30 * 86400_000);
            dateFrom.value = past.toISOString().slice(0, 10);
            dateTo.value = today.toISOString().slice(0, 10);
        }
    });
}

// ============================================================================
// Run backtest voor alle 4 profielen
// ============================================================================
// Vooraf-gedefinieerde marktcycli — handig om V2/V3 in 1 klik te testen
const BT_PRESETS = {
    'bullrun-2020-21': { from: '2020-10-01', to: '2021-11-01', label: '🚀 Bull run okt-2020 → nov-2021' },
    'bear-2022':       { from: '2022-01-01', to: '2022-12-31', label: '🐻 Bear markt 2022' },
    'sideways-2023h1': { from: '2023-01-01', to: '2023-06-30', label: '➡️ Zijwaarts/herstel H1 2023' },
};

function resolvePeriod() {
    // Returnt { sinceMs, untilMs, label, days }
    const sel = document.getElementById('bt-period').value;

    // Preset uit marktcycli
    if (sel.startsWith('preset:')) {
        const key = sel.slice('preset:'.length);
        const p = BT_PRESETS[key];
        if (!p) throw new Error(`Onbekende preset: ${key}`);
        const sinceMs = new Date(p.from + 'T00:00:00Z').getTime();
        const untilMs = new Date(p.to + 'T23:59:59Z').getTime();
        const days = Math.round((untilMs - sinceMs) / 86400_000);
        return { sinceMs, untilMs, label: `${p.label} (${days}d)`, days };
    }

    if (sel === 'custom') {
        const from = document.getElementById('bt-date-from').value;
        const to = document.getElementById('bt-date-to').value;
        if (!from || !to) throw new Error('Vul beide datums in voor Custom-periode');
        const sinceMs = new Date(from + 'T00:00:00Z').getTime();
        const untilMs = new Date(to + 'T23:59:59Z').getTime();
        if (sinceMs >= untilMs) throw new Error('"Vanaf" moet vóór "Tot en met" liggen');
        const days = Math.round((untilMs - sinceMs) / 86400_000);
        return { sinceMs, untilMs, label: `${from} → ${to} (${days}d)`, days };
    }

    const days = Number(sel);
    return {
        sinceMs: Date.now() - days * 86400_000,
        untilMs: Date.now(),
        label: `${days} dagen`,
        days,
    };
}

function gridSizeForDays(days) {
    if (days <= 60) return 'fine';     // ~50 combos
    if (days <= 365) return 'medium';  // ~30 combos
    return 'coarse';                   // ~9 combos
}

async function runBacktestUI() {
    const btn = document.getElementById('bt-run');
    btn.disabled = true;
    setBtStatus('Periode bepalen...');

    try {
        const period = resolvePeriod();
        const pairsChoice = document.getElementById('bt-pairs').value;
        const startCap = Number(document.getElementById('bt-capital').value);
        const includeAlt = document.getElementById('bt-include-altsearch').checked;
        const pairs = pairsChoice === 'both' ? ['BTC/EUR', 'ETH/EUR'] : [pairsChoice];

        // Progress callback voor lange fetches
        const onProgress = ({ pair, tf, loaded, oldestIso, chunks }) => {
            setBtStatus(`Candles ${pair} ${tf}: ${loaded.toLocaleString()} candles geladen (${chunks} chunks, terug tot ${oldestIso})...`);
        };

        const candlesByPair = {};
        const candles1hByPair = {};
        for (const pair of pairs) {
            setBtStatus(`Candles ophalen voor ${pair} (15m)...`);
            const c15m = await Backtest.fetchHistoricalCandles(pair, '15m', period.sinceMs, period.untilMs, onProgress);
            setBtStatus(`Candles ophalen voor ${pair} (1h)...`);
            const c1h  = await Backtest.fetchHistoricalCandles(pair, '1h',  period.sinceMs, period.untilMs, onProgress);
            candlesByPair[pair] = c15m;
            candles1hByPair[pair] = c1h;
            setBtStatus(`${pair}: ${c15m.length.toLocaleString()} × 15m + ${c1h.length.toLocaleString()} × 1h geladen`);
        }

        // 200MA market context — nodig voor V1 (use_200ma_filter) én V2 (use_regime_filter).
        // Fetch BTC daily candles vanaf 200 dagen vóór de backtest-start, zodat de
        // rolling 200MA al geldig is bij de eerste backtest-tick.
        let marketContext = null;
        const needsMa = PROFILES.some(p => p.use_200ma_filter || p.use_regime_filter || p.use_slope_filter);
        if (needsMa) {
            setBtStatus('Daily BTC candles ophalen voor 200MA filter...');
            const maSinceMs = period.sinceMs - 200 * 86400_000;
            const btcDaily = await Backtest.fetchHistoricalCandles('BTC/EUR', '1d', maSinceMs, period.untilMs, onProgress);
            marketContext = Backtest.buildMarketContext(btcDaily, 0.03);
            setBtStatus(`200MA geladen: ${btcDaily.length} daily candles (seed -200d voor rolling avg)`);
        }
        btLastCandles = { candlesByPair, candles1hByPair, marketContext };

        const totalCandles = Object.values(candlesByPair).reduce((s, c) => s + c.length, 0);
        setBtStatus(`Simuleren van ${totalCandles.toLocaleString()} candles voor 4 profielen...`);
        await new Promise(r => setTimeout(r, 50));

        const t0 = performance.now();
        const results = PROFILES.map(p => ({
            profile: p,
            ...Backtest.runBacktest(p, candlesByPair, candles1hByPair, startCap, marketContext),
        }));
        const elapsedMain = Math.round(performance.now() - t0);

        const buyHold = Backtest.buyAndHold(candlesByPair, startCap);
        btLastResults = results;
        btLastBuyHold = buyHold;

        // Wat-als — adaptief grid om lange backtests werkbaar te houden
        let alternatives = [];
        let elapsedAlt = 0;
        if (includeAlt) {
            const grid = gridSizeForDays(period.days);
            const gridDesc = { fine: '~50 combinaties', medium: '~30', coarse: '~9' }[grid];
            setBtStatus(`Scannen van alternatieve drempels (${grid} grid, ${gridDesc})...`);
            await new Promise(r => setTimeout(r, 30));
            const t1 = performance.now();
            // Base voor wat-als = Extreem (geen 200MA filter, geen trend filter,
            // hoogste risk/stop). Variëren alleen RSI-drempels om eerlijke
            // vergelijking met bestaande 4 profielen mogelijk te maken.
            const baseForAlt = PROFILES.find(p => p.key === 'extreem') || PROFILES[0];
            const existing = PROFILES.map(p => ({ os: p.rsi_oversold, ob: p.rsi_overbought }));
            alternatives = Backtest.findTopAlternatives(
                baseForAlt, candlesByPair, candles1hByPair, existing, 3, startCap, grid
            ).map((alt, i) => ({
                ...alt,
                profile: { ...alt.profile, color: BT_ALT_COLORS[i] },
            }));
            elapsedAlt = Math.round(performance.now() - t1);
        }
        btLastAlternatives = alternatives;

        renderKpiTable(results, alternatives, buyHold, startCap);
        renderDiagnose(results);
        renderEquityChart(results, alternatives, buyHold);
        document.getElementById('bt-results').classList.remove('hidden');

        const altMsg = includeAlt ? ` + ${alternatives.length} alternatieven (${elapsedAlt}ms)` : ' (wat-als uit)';
        setBtStatus(`✅ Klaar — ${period.label}, ${totalCandles.toLocaleString()} candles · 4 profielen (${elapsedMain}ms)${altMsg}`);
    } catch (e) {
        console.error(e);
        setBtStatus('⚠ ' + e.message);
    } finally {
        btn.disabled = false;
    }
}

function renderKpiTable(results, alternatives, buyHold, startCap) {
    const fmtEur = n => '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtPct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
    const pnlClass = n => n >= 0 ? 'pnl-pos' : 'pnl-neg';

    const COL_COUNT = 12;
    const headers = ['Profiel', 'Eindwaarde', 'Rendement', 'PnL', '# Trades', 'Win%', 'Profit factor', 'Max drawdown', 'Gem trade (min)', 'Max win', 'Max loss', 'Stop loss\'es'];

    function rowFor(r, isAlt = false) {
        const s = r.stats;
        const labelExtra = isAlt ? ` <span class="text-[10px] text-slate-500 ml-1 normal-case font-normal">(${r.profile.rsi_oversold}/${r.profile.rsi_overbought})</span>` : '';
        return [
            { value: r.profile.label + labelExtra, color: r.profile.color, html: true },
            { value: fmtEur(s.finalValue), cls: pnlClass(s.finalValue - startCap) },
            { value: fmtPct(s.totalReturn), cls: pnlClass(s.totalReturn), bold: true },
            { value: fmtEur(s.totalPnl), cls: pnlClass(s.totalPnl) },
            { value: String(s.totalTrades) },
            { value: s.totalTrades ? (s.winrate * 100).toFixed(0) + '%' : '—' },
            { value: Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞' },
            { value: (s.maxDrawdown * 100).toFixed(2) + '%', cls: 'pnl-neg' },
            { value: s.avgDurationMin ? s.avgDurationMin.toFixed(0) : '—' },
            { value: fmtEur(s.maxWin), cls: 'pnl-pos' },
            { value: fmtEur(s.maxLoss), cls: 'pnl-neg' },
            { value: String(s.stops) },
        ];
    }

    const mainRows = results.map(r => rowFor(r));
    const altRows = (alternatives || []).map(r => rowFor(r, true));
    const bhRow = [
        { value: 'Buy & Hold', color: BT_COLORS['buy-hold'] },
        { value: fmtEur(buyHold.finalValue), cls: pnlClass(buyHold.finalValue - startCap) },
        { value: fmtPct(buyHold.totalReturn), cls: pnlClass(buyHold.totalReturn), bold: true },
        { value: fmtEur(buyHold.finalValue - startCap), cls: pnlClass(buyHold.finalValue - startCap) },
        { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' },
    ];

    function renderRows(rows, isAlt = false) {
        return rows.map(r => `
            <tr class="border-b border-slate-800 hover:bg-slate-900/40 ${isAlt ? 'bg-fuchsia-500/[0.03]' : ''}">
                ${r.map(c => `<td class="py-2 px-2 ${c.cls || ''} ${c.bold ? 'font-semibold' : ''}" ${c.color ? `style="color:${c.color}"` : ''}>${c.html ? c.value : escapeHtml(c.value)}</td>`).join('')}
            </tr>
        `).join('');
    }

    const sectionHeader = (label, hint) => `
        <tr><td colspan="${COL_COUNT}" class="pt-4 pb-1 px-2 text-[10px] uppercase tracking-wider text-slate-500 font-semibold border-b border-slate-700">
            ${label} <span class="ml-2 text-slate-600 normal-case font-normal">${hint}</span>
        </td></tr>`;

    const tbl = document.getElementById('bt-table');
    tbl.innerHTML = `
        <thead>
            <tr class="border-b border-slate-700">
                ${headers.map(h => `<th class="text-left py-2 px-2 font-medium text-slate-400 text-[11px] uppercase tracking-wide">${h}</th>`).join('')}
            </tr>
        </thead>
        <tbody>
            ${sectionHeader('Jouw 4 profielen', '')}
            ${renderRows(mainRows)}
            ${altRows.length ? sectionHeader('🔮 Wat als — top 3 alternatieve drempels', '(zelfde risk + stop als Gemiddeld, alleen RSI varieert)') : ''}
            ${renderRows(altRows, true)}
            ${sectionHeader('Benchmark', '(passief kopen, nooit verkopen)')}
            <tr class="border-b border-slate-800">
                ${bhRow.map(c => `<td class="py-2 px-2 ${c.cls || ''} ${c.bold ? 'font-semibold' : ''}" ${c.color ? `style="color:${c.color}"` : ''}>${escapeHtml(c.value)}</td>`).join('')}
            </tr>
        </tbody>
    `;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

// --- Diagnose panel: regime breakdown per Adaptief profiel ---
const REGIME_COLORS = {
    'bull': '#f59e0b', 'neutral': '#06b6d4', 'bear': '#ef4444',
    'above-far': '#f59e0b', 'above-close': '#06b6d4',
    'bear-falling': '#dc2626', 'bear-rising': '#fb923c',
};
const REGIME_LABELS = {
    'bull': '⏸ Bull (pauze)', 'neutral': '➡️ Neutraal', 'bear': '🐻 Bear',
    'above-far': '⏸ Boven MA >10% (pauze)', 'above-close': '➡️ Boven MA <10%',
    'bear-falling': '🐻↘ Bear-dalend', 'bear-rising': '🐻↗ Bear-stijgend',
};

function renderDiagnose(results) {
    const filtered = results.filter(r =>
        r.profile.use_200ma_filter || r.profile.use_regime_filter || r.profile.use_slope_filter
    );
    const section = document.getElementById('bt-diagnose-section');
    const content = document.getElementById('bt-diagnose-content');
    if (!filtered.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');

    content.innerHTML = filtered.map(r => {
        const s = r.stats;
        const total = s.regimeTotalTicks || 0;
        const dist = s.regimeDistribution || {};
        const sortedRegimes = Object.entries(dist).sort((a, b) => b[1] - a[1]);

        const bars = sortedRegimes.map(([key, count]) => {
            const pct = total ? (count / total * 100) : 0;
            const color = REGIME_COLORS[key] || '#64748b';
            const label = REGIME_LABELS[key] || key;
            return `
                <div class="text-xs">
                    <div class="flex justify-between mb-0.5">
                        <span>${label}</span>
                        <span class="text-slate-500">${pct.toFixed(1)}% · ${count.toLocaleString()} ticks</span>
                    </div>
                    <div class="h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div class="h-full" style="background:${color};width:${pct.toFixed(2)}%"></div>
                    </div>
                </div>`;
        }).join('');

        const pausedTotal = (s.pausedBuys || 0) + (s.pausedByRegime || 0);
        const conclusie = total === 0
            ? '⚠ Geen regime-data — fetch faalde of seed periode ontbrak'
            : pausedTotal === 0 && s.totalTrades > 0
                ? `✓ Filter was actief maar blokkeerde 0 BUYs — markt zat nooit in een pauze-regime tijdens een BUY-moment. Rendement = puur RSI-strategie.`
                : pausedTotal > 0
                    ? `✓ Filter blokkeerde ~${pausedTotal.toLocaleString()} BUY-signalen tijdens pauze-regimes. Pauze werkt correct. ${s.totalTrades} trades hebben dus pre-pauze of post-pauze plaatsgevonden.`
                    : `✓ Filter actief. ${s.totalTrades} trades.`;

        return `
            <div class="border border-slate-800 rounded-lg p-3 sm:p-4">
                <div class="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <div class="font-semibold text-sm" style="color:${r.profile.color}">${r.profile.label}</div>
                    <div class="text-xs text-slate-500">${total.toLocaleString()} ticks · ${s.totalTrades} trades · ~${pausedTotal.toLocaleString()} BUYs gepauzeerd</div>
                </div>
                <div class="space-y-1.5 mb-3">${bars}</div>
                <div class="text-xs text-slate-400 italic">${conclusie}</div>
            </div>`;
    }).join('');
}

function renderEquityChart(results, alternatives, buyHold) {
    const datasets = results.map(r => ({
        label: r.profile.label,
        data: r.equity.map(e => ({ x: new Date(e.t), y: e.value })),
        borderColor: r.profile.color,
        backgroundColor: r.profile.color + '15',
        tension: 0.1, pointRadius: 0, borderWidth: 2,
    }));
    // Wat-als alternatieven — gestippeld, dunner, fuchsia-tinten
    for (const alt of (alternatives || [])) {
        datasets.push({
            label: `${alt.profile.label} (wat-als)`,
            data: alt.equity.map(e => ({ x: new Date(e.t), y: e.value })),
            borderColor: alt.profile.color,
            backgroundColor: alt.profile.color + '0a',
            borderDash: [6, 3],
            tension: 0.1, pointRadius: 0, borderWidth: 1.5,
        });
    }
    datasets.push({
        label: 'Buy & Hold',
        data: buyHold.equity.map(e => ({ x: new Date(e.t), y: e.value })),
        borderColor: BT_COLORS['buy-hold'],
        backgroundColor: BT_COLORS['buy-hold'] + '15',
        borderDash: [2, 2], tension: 0.1, pointRadius: 0, borderWidth: 1.5,
    });

    if (btEquityChart) {
        btEquityChart.data.datasets = datasets;
        btEquityChart.update('none');
        return;
    }
    btEquityChart = new Chart(document.getElementById('bt-equity-chart'), {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: 'rgb(148 163 184)' } },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: €${Number(ctx.parsed.y).toLocaleString('nl-NL', { minimumFractionDigits: 2 })}` } },
            },
            scales: {
                x: { type: 'time', time: { unit: 'day' }, ticks: { color: 'rgb(100 116 139)' }, grid: { color: 'rgb(30 41 59 / 0.5)' } },
                y: { ticks: { color: 'rgb(100 116 139)', callback: v => '€' + v }, grid: { color: 'rgb(30 41 59 / 0.5)' } },
            },
        },
    });
}

// ============================================================================
// Optimizer
// ============================================================================
async function runOptimizerUI() {
    if (!btLastCandles) {
        setBtOptStatus('⚠ Eerst een backtest runnen — daarna scan ik de drempels op dezelfde data');
        return;
    }
    const btn = document.getElementById('bt-optimize');
    btn.disabled = true;
    setBtOptStatus('Scannen...');
    await new Promise(r => setTimeout(r, 50));

    try {
        const baseKey = document.getElementById('bt-opt-base').value;
        const base = PROFILES.find(p => p.key === baseKey);
        const grid = {
            oversold:   [20, 25, 30, 35, 40, 45],
            overbought: [55, 60, 65, 70, 75, 80],
        };
        const t0 = performance.now();
        const results = Backtest.optimizeThresholds(base, btLastCandles.candlesByPair, btLastCandles.candles1hByPair, grid);
        const ms = Math.round(performance.now() - t0);
        btLastOpt = { base, results };

        renderOptimizerTable(results, base);
        setBtOptStatus(`✅ ${results.length} combinaties getest in ${ms}ms (basis = ${base.label}, risk/stop/trend-filter ongewijzigd)`);
    } catch (e) {
        console.error(e);
        setBtOptStatus('⚠ ' + e.message);
    } finally {
        btn.disabled = false;
    }
}

function renderOptimizerTable(results, base) {
    const fmtPct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
    const fmtEur = n => '€' + Number(n).toFixed(2);
    const pnlClass = n => n >= 0 ? 'pnl-pos' : 'pnl-neg';

    const headers = ['#', 'RSI oversold', 'RSI overbought', 'Rendement', 'Trades', 'Winrate', 'Max DD', 'Profit factor', 'Eindwaarde'];
    const rows = results.slice(0, 20).map((r, i) => {
        const isCurrent = r.oversold === base.rsi_oversold && r.overbought === base.rsi_overbought;
        return `
            <tr class="border-b border-slate-800 ${isCurrent ? 'bg-emerald-500/10' : 'hover:bg-slate-900/40'}">
                <td class="py-2 px-2 text-slate-500">${i + 1}${isCurrent ? ' ★' : ''}</td>
                <td class="py-2 px-2">${r.oversold}</td>
                <td class="py-2 px-2">${r.overbought}</td>
                <td class="py-2 px-2 font-semibold ${pnlClass(r.return)}">${fmtPct(r.return)}</td>
                <td class="py-2 px-2">${r.trades}</td>
                <td class="py-2 px-2">${r.trades ? (r.winrate * 100).toFixed(0) + '%' : '—'}</td>
                <td class="py-2 px-2 pnl-neg">${(r.maxDrawdown * 100).toFixed(1)}%</td>
                <td class="py-2 px-2">${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}</td>
                <td class="py-2 px-2">${fmtEur(r.finalValue)}</td>
            </tr>`;
    }).join('');

    const tbl = document.getElementById('bt-opt-table');
    tbl.classList.remove('hidden');
    tbl.innerHTML = `
        <thead>
            <tr class="border-b border-slate-700">
                ${headers.map(h => `<th class="text-left py-2 px-2 font-medium text-slate-400 text-[11px] uppercase tracking-wide">${h}</th>`).join('')}
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    `;
}

// ============================================================================
// Export backtest naar Excel (gebruikt SheetJS, al geladen voor analyse-export)
// ============================================================================
function exportBacktestResults() {
    if (!btLastResults) { alert('Eerst een backtest runnen'); return; }
    const wb = XLSX.utils.book_new();

    // Sheet 1: Summary
    const summary = btLastResults.map(r => ({
        profiel: r.profile.label,
        rsi_oversold: r.profile.rsi_oversold,
        rsi_overbought: r.profile.rsi_overbought,
        trend_filter: r.profile.trend_filter ?? 'geen',
        max_positions: r.profile.max_positions,
        risk_pct: r.profile.risk_per_trade,
        stop_pct: r.profile.stop_loss_pct,
        startkapitaal: r.startCap,
        eindwaarde: round2(r.stats.finalValue),
        rendement_pct: round4(r.stats.totalReturn),
        pnl_eur: round2(r.stats.totalPnl),
        totaal_trades: r.stats.totalTrades,
        wins: r.stats.wins,
        losses: r.stats.losses,
        winrate_pct: round4(r.stats.winrate),
        profit_factor: Number.isFinite(r.stats.profitFactor) ? round2(r.stats.profitFactor) : '∞',
        max_drawdown_pct: round4(r.stats.maxDrawdown),
        avg_duration_min: round2(r.stats.avgDurationMin),
        max_win: round2(r.stats.maxWin),
        max_loss: round2(r.stats.maxLoss),
        opens: r.stats.opens,
        sells: r.stats.sells,
        stops: r.stats.stops,
        paused_by_filter: (r.stats.pausedBuys || 0) + (r.stats.pausedByRegime || 0),
        regime_ticks_total: r.stats.regimeTotalTicks || 0,
        regime_distribution: JSON.stringify(r.stats.regimeDistribution || {}),
    }));
    summary.push({
        profiel: 'Buy & Hold (benchmark)', eindwaarde: round2(btLastBuyHold.finalValue),
        rendement_pct: round4(btLastBuyHold.totalReturn),
        pnl_eur: round2(btLastBuyHold.finalValue - btLastResults[0].startCap),
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');

    // Sheet: alternatieven
    if (btLastAlternatives && btLastAlternatives.length) {
        const altRows = btLastAlternatives.map((r, i) => ({
            rank: i + 1,
            label: r.profile.label,
            rsi_oversold: r.profile.rsi_oversold,
            rsi_overbought: r.profile.rsi_overbought,
            trend_filter: r.profile.trend_filter ?? 'geen',
            risk_pct: r.profile.risk_per_trade,
            stop_pct: r.profile.stop_loss_pct,
            eindwaarde: round2(r.stats.finalValue),
            rendement_pct: round4(r.stats.totalReturn),
            trades: r.stats.totalTrades,
            winrate_pct: round4(r.stats.winrate),
            max_drawdown_pct: round4(r.stats.maxDrawdown),
            profit_factor: Number.isFinite(r.stats.profitFactor) ? round2(r.stats.profitFactor) : '∞',
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(altRows), 'Wat-als alternatieven');
    }

    // Sheet 2-5: trades per profiel
    for (const r of btLastResults) {
        const rows = r.trades.map(t => ({
            opened_at: new Date(t.openedAt).toISOString(),
            closed_at: new Date(t.closedAt).toISOString(),
            duration_min: round2(t.durationMs / 60000),
            pair: t.pair,
            entry: round2(t.entry),
            exit: round2(t.exit),
            size: t.size,
            pnl: round2(t.pnl),
            pnl_pct: round4(t.pnlPct),
            reason: t.reason,
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ info: '(geen trades)' }]), 'Trades ' + r.profile.label);
    }

    // Sheet equity
    const tsSet = new Set();
    for (const r of btLastResults) for (const e of r.equity) tsSet.add(e.t);
    const ts = [...tsSet].sort((a, b) => a - b);
    const tsIdx = Object.fromEntries(ts.map((t, i) => [t, i]));
    const equityRows = ts.map(t => ({ timestamp: new Date(t).toISOString() }));
    for (const r of btLastResults) {
        const m = new Map(r.equity.map(e => [e.t, e.value]));
        for (const t of ts) {
            equityRows[tsIdx[t]][r.profile.label] = m.has(t) ? round2(m.get(t)) : '';
        }
    }
    if (btLastBuyHold) {
        const m = new Map(btLastBuyHold.equity.map(e => [e.t, e.value]));
        for (const t of ts) {
            equityRows[tsIdx[t]]['Buy & Hold'] = m.has(t) ? round2(m.get(t)) : '';
        }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(equityRows), 'Equity curve');

    // Sheet optimizer als die gedraaid is
    if (btLastOpt) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(btLastOpt.results.map((r, i) => ({
            rank: i + 1,
            rsi_oversold: r.oversold,
            rsi_overbought: r.overbought,
            rendement_pct: round4(r.return),
            trades: r.trades,
            winrate_pct: round4(r.winrate),
            max_drawdown_pct: round4(r.maxDrawdown),
            profit_factor: Number.isFinite(r.profitFactor) ? round2(r.profitFactor) : '∞',
            eindwaarde: round2(r.finalValue),
        }))), 'Optimizer ' + btLastOpt.base.label);
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    XLSX.writeFile(wb, `trade-bot-backtest-${stamp}.xlsx`);
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function round4(n) { return Math.round(Number(n) * 10000) / 10000; }
