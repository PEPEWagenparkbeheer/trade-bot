// Backtest UI — koppelt het form aan de runner in backtest.js,
// rendert KPI-tabel, equity curve en optimizer ranking.

let btLastResults = null;       // [{profile, ...result}, ...]
let btLastBuyHold = null;
let btLastCandles = null;       // { candlesByPair, candles1hByPair }
let btLastOpt = null;           // optimizer rijen
let btEquityChart = null;

const BT_COLORS = {
    laag: '#22c55e', gemiddeld: '#3b82f6', hoog: '#f59e0b', extreem: '#ef4444',
    'buy-hold': '#a855f7',
};

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
}

// ============================================================================
// Run backtest voor alle 4 profielen
// ============================================================================
async function runBacktestUI() {
    const btn = document.getElementById('bt-run');
    btn.disabled = true;
    setBtStatus('Historische candles ophalen...');

    try {
        const days = Number(document.getElementById('bt-period').value);
        const pairsChoice = document.getElementById('bt-pairs').value;
        const startCap = Number(document.getElementById('bt-capital').value);
        const pairs = pairsChoice === 'both' ? ['BTC/EUR', 'ETH/EUR'] : [pairsChoice];

        const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const untilMs = Date.now();

        // Fetch alle pairs in parallel, 15m én 1h
        const candlesByPair = {};
        const candles1hByPair = {};
        for (const pair of pairs) {
            setBtStatus(`Candles ophalen voor ${pair}...`);
            const [c15m, c1h] = await Promise.all([
                Backtest.fetchHistoricalCandles(pair, '15m', sinceMs, untilMs),
                Backtest.fetchHistoricalCandles(pair, '1h', sinceMs, untilMs),
            ]);
            candlesByPair[pair] = c15m;
            candles1hByPair[pair] = c1h;
            setBtStatus(`${pair}: ${c15m.length} × 15m + ${c1h.length} × 1h candles geladen`);
        }
        btLastCandles = { candlesByPair, candles1hByPair };

        const totalCandles = Object.values(candlesByPair).reduce((s, c) => s + c.length, 0);
        setBtStatus(`Simuleren van ${totalCandles} candles voor 4 profielen...`);
        await new Promise(r => setTimeout(r, 50));   // laat UI updaten

        // Run alle 4 profielen
        const t0 = performance.now();
        const results = PROFILES.map(p => ({
            profile: p,
            ...Backtest.runBacktest(p, candlesByPair, candles1hByPair, startCap),
        }));
        const elapsedMs = Math.round(performance.now() - t0);

        const buyHold = Backtest.buyAndHold(candlesByPair, startCap);
        btLastResults = results;
        btLastBuyHold = buyHold;

        renderKpiTable(results, buyHold, startCap);
        renderEquityChart(results, buyHold);
        document.getElementById('bt-results').classList.remove('hidden');

        setBtStatus(`✅ Klaar — ${days} dagen, ${totalCandles} candles, 4 profielen gesimuleerd in ${elapsedMs}ms`);
    } catch (e) {
        console.error(e);
        setBtStatus('⚠ ' + e.message);
    } finally {
        btn.disabled = false;
    }
}

function renderKpiTable(results, buyHold, startCap) {
    const fmtEur = n => '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtPct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
    const pnlClass = n => n >= 0 ? 'pnl-pos' : 'pnl-neg';

    const headers = ['Profiel', 'Eindwaarde', 'Rendement', 'PnL', '# Trades', 'Win%', 'Profit factor', 'Max drawdown', 'Gem trade (min)', 'Max win', 'Max loss', 'Stop loss\'es'];
    const rows = results.map(r => {
        const s = r.stats;
        return [
            { value: r.profile.label, raw: r.profile.label, color: r.profile.color },
            { value: fmtEur(s.finalValue), raw: s.finalValue, cls: pnlClass(s.finalValue - startCap) },
            { value: fmtPct(s.totalReturn), raw: s.totalReturn, cls: pnlClass(s.totalReturn), bold: true },
            { value: fmtEur(s.totalPnl), raw: s.totalPnl, cls: pnlClass(s.totalPnl) },
            { value: String(s.totalTrades), raw: s.totalTrades },
            { value: s.totalTrades ? (s.winrate * 100).toFixed(0) + '%' : '—', raw: s.winrate },
            { value: Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞', raw: s.profitFactor },
            { value: (s.maxDrawdown * 100).toFixed(2) + '%', raw: s.maxDrawdown, cls: 'pnl-neg' },
            { value: s.avgDurationMin ? s.avgDurationMin.toFixed(0) : '—', raw: s.avgDurationMin },
            { value: fmtEur(s.maxWin), raw: s.maxWin, cls: 'pnl-pos' },
            { value: fmtEur(s.maxLoss), raw: s.maxLoss, cls: 'pnl-neg' },
            { value: String(s.stops), raw: s.stops },
        ];
    });
    // Voeg buy-and-hold rij toe als benchmark
    rows.push([
        { value: 'Buy & Hold (benchmark)', color: BT_COLORS['buy-hold'] },
        { value: fmtEur(buyHold.finalValue), cls: pnlClass(buyHold.finalValue - startCap) },
        { value: fmtPct(buyHold.totalReturn), cls: pnlClass(buyHold.totalReturn), bold: true },
        { value: fmtEur(buyHold.finalValue - startCap), cls: pnlClass(buyHold.finalValue - startCap) },
        { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' }, { value: '—' },
    ]);

    const tbl = document.getElementById('bt-table');
    tbl.innerHTML = `
        <thead>
            <tr class="border-b border-slate-700">
                ${headers.map(h => `<th class="text-left py-2 px-2 font-medium text-slate-400 text-[11px] uppercase tracking-wide">${h}</th>`).join('')}
            </tr>
        </thead>
        <tbody>
            ${rows.map(r => `
                <tr class="border-b border-slate-800 hover:bg-slate-900/40">
                    ${r.map((c, i) => `<td class="py-2 px-2 ${c.cls || ''} ${c.bold ? 'font-semibold' : ''}" ${c.color ? `style="color:${c.color}"` : ''}>${c.value}</td>`).join('')}
                </tr>
            `).join('')}
        </tbody>
    `;
}

function renderEquityChart(results, buyHold) {
    const datasets = results.map(r => ({
        label: r.profile.label,
        data: r.equity.map(e => ({ x: new Date(e.t), y: e.value })),
        borderColor: r.profile.color,
        backgroundColor: r.profile.color + '15',
        tension: 0.1, pointRadius: 0, borderWidth: 2,
    }));
    datasets.push({
        label: 'Buy & Hold',
        data: buyHold.equity.map(e => ({ x: new Date(e.t), y: e.value })),
        borderColor: BT_COLORS['buy-hold'],
        backgroundColor: BT_COLORS['buy-hold'] + '15',
        borderDash: [4, 4], tension: 0.1, pointRadius: 0, borderWidth: 2,
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
    }));
    summary.push({
        profiel: 'Buy & Hold (benchmark)', eindwaarde: round2(btLastBuyHold.finalValue),
        rendement_pct: round4(btLastBuyHold.totalReturn),
        pnl_eur: round2(btLastBuyHold.finalValue - btLastResults[0].startCap),
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');

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
