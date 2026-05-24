// Uitgebreide XLSX export voor analyse.
// Eén Excel-bestand met meerdere sheets + derived metrics + summary statistieken.
//
// Aangeroepen vanuit charts.js setupTabs() (gebruikt `api(...)`, `PROFILES` van daar).

const PERIOD_MS = {
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    'all': null,
};

function periodCutoff(periodKey) {
    const ms = PERIOD_MS[periodKey];
    return ms == null ? null : new Date(Date.now() - ms);
}

function withinPeriod(timestamp, cutoff) {
    if (!cutoff) return true;
    return new Date(timestamp) >= cutoff;
}

async function setupXlsxExport() {
    const btn = document.getElementById('export-xlsx');
    const status = document.getElementById('export-status');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        const period = document.getElementById('export-period').value;
        const profileSel = document.getElementById('export-profile').value;
        btn.disabled = true;
        status.textContent = 'Data ophalen...';
        try {
            const result = await buildAnalysisWorkbook({ period, profileFilter: profileSel });
            status.textContent = `Klaar — ${result.rowsTotal} rijen geëxporteerd`;
            setTimeout(() => { status.textContent = ''; }, 4000);
        } catch (e) {
            console.error(e);
            status.textContent = '⚠ ' + e.message;
        } finally {
            btn.disabled = false;
        }
    });
}

async function buildAnalysisWorkbook({ period, profileFilter }) {
    const cutoff = periodCutoff(period);
    const activeProfiles = profileFilter === 'all'
        ? PROFILES.map(p => p.key)
        : [profileFilter];

    // 1. Fetch alles parallel — bovenlimieten ruim
    const [signalsRaw, tradesRaw, portfolioRaw, positionsRaw] = await Promise.all([
        api('/signals',   { limit: 10000 }),
        api('/trades',    { limit: 10000 }),
        fetchAllPortfolioHistory(activeProfiles),
        api('/positions', {}),
    ]);

    // 2. Filter op profile + periode
    const signals = (signalsRaw.signals || [])
        .filter(s => activeProfiles.includes(s.profile))
        .filter(s => withinPeriod(s.created_at, cutoff));
    const trades = (tradesRaw.trades || [])
        .filter(t => activeProfiles.includes(t.profile))
        .filter(t => withinPeriod(t.closed_at, cutoff));
    const portfolio = portfolioRaw
        .filter(p => withinPeriod(p.snapshot_at, cutoff));
    const positions = (positionsRaw.positions || [])
        .filter(p => activeProfiles.includes(p.profile));

    // 3. Bouw sheets
    const wb = XLSX.utils.book_new();

    addSheet(wb, 'Summary',           buildSummaryRows(activeProfiles, signals, trades, portfolio, positions));
    addSheet(wb, 'Trades',            enrichTrades(trades));
    addSheet(wb, 'Signals',           enrichSignals(signals));
    addSheet(wb, 'Portfolio history', enrichPortfolio(portfolio));
    addSheet(wb, 'Open positions',    enrichOpenPositions(positions));
    addSheet(wb, 'Configuratie',      buildConfigRows(activeProfiles));

    // 4. Download
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const profileTag = profileFilter === 'all' ? 'alle' : profileFilter;
    const filename = `trade-bot-${profileTag}-${period}-${stamp}.xlsx`;
    XLSX.writeFile(wb, filename);

    return {
        rowsTotal: signals.length + trades.length + portfolio.length + positions.length,
    };
}

async function fetchAllPortfolioHistory(profileKeys) {
    // /portfolio?profile=X geeft alleen 1 profile terug — we hebben alle profielen nodig
    const all = await Promise.all(profileKeys.map(async key => {
        const r = await api('/portfolio', { profile: key });
        return (r.history || []).map(h => ({ ...h, profile: key }));
    }));
    return all.flat();
}

function addSheet(wb, name, rows) {
    if (!rows.length) {
        const ws = XLSX.utils.aoa_to_sheet([['(geen data)']]);
        XLSX.utils.book_append_sheet(wb, ws, name);
        return;
    }
    const ws = XLSX.utils.json_to_sheet(rows);
    // Auto-size kolommen op basis van max content lengte (eenvoudige heuristic)
    const headers = Object.keys(rows[0]);
    ws['!cols'] = headers.map(h => {
        const maxLen = Math.max(h.length, ...rows.slice(0, 200).map(r => String(r[h] ?? '').length));
        return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
    });
    XLSX.utils.book_append_sheet(wb, ws, name);
}

// --- Derived columns ---------------------------------------------------------

function enrichTrades(trades) {
    // Per profile een running cumulatieve PnL bijhouden
    const cumPerProfile = {};
    // Trades komen nieuwste-eerst — voor cumPnL willen we oudste-eerst
    const ordered = [...trades].sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));
    const enriched = ordered.map(t => {
        const entry = Number(t.entry_price);
        const exit = Number(t.exit_price);
        const size = Number(t.size);
        const pnl = Number(t.pnl);
        const entryValue = size * entry;
        const exitValue = size * exit;
        const pnlPct = entry !== 0 ? (exit - entry) / entry : 0;
        const opened = new Date(t.opened_at);
        const closed = new Date(t.closed_at);
        const durationMin = (closed - opened) / 60000;
        cumPerProfile[t.profile] = (cumPerProfile[t.profile] || 0) + pnl;
        return {
            profile:           t.profile,
            pair:              t.pair,
            opened_at:         t.opened_at,
            closed_at:         t.closed_at,
            duration_minuten:  round2(durationMin),
            entry_price:       round2(entry),
            exit_price:        round2(exit),
            size:              size,
            entry_value_eur:   round2(entryValue),
            exit_value_eur:    round2(exitValue),
            pnl_eur:           round2(pnl),
            pnl_pct:           round4(pnlPct),
            cumulatieve_pnl_eur: round2(cumPerProfile[t.profile]),
            reason:            t.reason,
            outcome:           pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAK_EVEN',
        };
    });
    // Sorteer terug naar nieuwste-eerst voor leesbaarheid
    return enriched.reverse();
}

function enrichSignals(signals) {
    return signals.map(s => {
        const rsi15 = Number(s.rsi_15m);
        const rsi1h = Number(s.rsi_1h);
        return {
            profile:       s.profile,
            created_at:    s.created_at,
            pair:          s.pair,
            action:        s.action,
            price_eur:     round2(Number(s.price)),
            rsi_15m:       round2(rsi15),
            rsi_1h:        round2(rsi1h),
            rsi_15m_zone:  rsiZone(rsi15),
            rsi_1h_zone:   rsiZone(rsi1h),
            reason:        s.reason,
        };
    });
}

function enrichPortfolio(rows) {
    const ordered = [...rows].sort((a, b) => new Date(a.snapshot_at) - new Date(b.snapshot_at));
    return ordered.map(r => ({
        profile:         r.profile,
        snapshot_at:     r.snapshot_at,
        capital_eur:     round2(Number(r.capital)),
        market_value_eur: round2(Number(r.market_value)),
        total_value_eur: round2(Number(r.total_value)),
        realised_pnl_eur: round2(Number(r.realised_pnl)),
        open_positions:  r.open_positions,
        rendement_pct:   round4((Number(r.total_value) - 1000) / 1000),
    }));
}

function enrichOpenPositions(positions) {
    return positions.map(p => ({
        profile:           p.profile,
        pair:              p.pair,
        opened_at:         p.opened_at,
        entry_price_eur:   round2(Number(p.entry_price)),
        current_price_eur: round2(Number(p.current_price)),
        size:              Number(p.size),
        entry_value_eur:   round2(Number(p.size) * Number(p.entry_price)),
        market_value_eur:  round2(Number(p.market_value)),
        stop_loss_eur:     round2(Number(p.stop_loss_price)),
        afstand_tot_stop_pct: round4((Number(p.current_price) - Number(p.stop_loss_price)) / Number(p.current_price)),
        unrealised_pnl_eur: round2(Number(p.unrealised_pnl)),
        unrealised_pnl_pct: round4(Number(p.unrealised_pnl_pct)),
    }));
}

// --- Summary -----------------------------------------------------------------

function buildSummaryRows(activeProfiles, signals, trades, portfolio, positions) {
    return activeProfiles.map(key => {
        const p = PROFILES.find(x => x.key === key);
        const myTrades = trades.filter(t => t.profile === key);
        const mySignals = signals.filter(s => s.profile === key);
        const myPositions = positions.filter(x => x.profile === key);
        const myPortfolio = portfolio.filter(x => x.profile === key);

        const wins = myTrades.filter(t => Number(t.pnl) > 0);
        const losses = myTrades.filter(t => Number(t.pnl) < 0);
        const totalPnl = sum(myTrades.map(t => Number(t.pnl)));
        const avgPnl = myTrades.length ? totalPnl / myTrades.length : 0;
        const avgWin = wins.length ? sum(wins.map(t => Number(t.pnl))) / wins.length : 0;
        const avgLoss = losses.length ? sum(losses.map(t => Number(t.pnl))) / losses.length : 0;
        const maxWin = wins.length ? Math.max(...wins.map(t => Number(t.pnl))) : 0;
        const maxLoss = losses.length ? Math.min(...losses.map(t => Number(t.pnl))) : 0;
        const winrate = myTrades.length ? wins.length / myTrades.length : 0;
        const profitFactor = Math.abs(avgLoss) > 0
            ? (avgWin * wins.length) / Math.abs(avgLoss * losses.length || 1)
            : (wins.length > 0 ? Infinity : 0);

        const latest = myPortfolio.slice().sort((a,b) => new Date(b.snapshot_at) - new Date(a.snapshot_at))[0];
        const currentValue = latest ? Number(latest.total_value) : 1000;
        const unrealised = sum(myPositions.map(x => Number(x.unrealised_pnl)));

        const buySignals = mySignals.filter(s => s.action === 'BUY').length;
        const sellSignals = mySignals.filter(s => s.action === 'SELL').length;
        const holdSignals = mySignals.filter(s => s.action === 'HOLD').length;

        return {
            profiel:               p.label,
            rsi_oversold:          p.rsi_oversold,
            rsi_overbought:        p.rsi_overbought,
            trend_filter:          p.trend_filter ?? 'geen',
            max_posities:          p.max_positions,
            risk_pct:              round4(p.risk_per_trade),
            stop_loss_pct:         round4(p.stop_loss_pct),
            startkapitaal_eur:     1000,
            huidige_waarde_eur:    round2(currentValue),
            rendement_pct:         round4((currentValue - 1000) / 1000),
            rendement_eur:         round2(currentValue - 1000),
            gerealiseerde_pnl_eur: round2(totalPnl),
            ongerealiseerd_pnl_eur: round2(unrealised),
            totaal_trades:         myTrades.length,
            wins:                  wins.length,
            losses:                losses.length,
            winrate_pct:           round4(winrate),
            gem_pnl_per_trade_eur: round2(avgPnl),
            gem_win_eur:           round2(avgWin),
            gem_loss_eur:          round2(avgLoss),
            max_win_eur:           round2(maxWin),
            max_loss_eur:          round2(maxLoss),
            profit_factor:         Number.isFinite(profitFactor) ? round2(profitFactor) : '∞',
            open_posities:         myPositions.length,
            totaal_signalen:       mySignals.length,
            buy_signalen:          buySignals,
            sell_signalen:         sellSignals,
            hold_signalen:         holdSignals,
        };
    });
}

function buildConfigRows(activeProfiles) {
    return activeProfiles.map(key => {
        const p = PROFILES.find(x => x.key === key);
        return {
            profiel:        p.label,
            key:            p.key,
            rsi_oversold:   p.rsi_oversold,
            rsi_overbought: p.rsi_overbought,
            trend_filter:   p.trend_filter ?? 'geen',
            max_positions:  p.max_positions,
            risk_per_trade: p.risk_per_trade,
            stop_loss_pct:  p.stop_loss_pct,
            kleur:          p.color,
        };
    });
}

// --- Utils -------------------------------------------------------------------

function rsiZone(rsi) {
    if (rsi < 30) return 'oversold';
    if (rsi > 70) return 'overbought';
    return 'neutraal';
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function round4(n) { return Math.round(Number(n) * 10000) / 10000; }
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
