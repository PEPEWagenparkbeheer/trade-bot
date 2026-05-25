"""Diagnose data-consistentie tussen trades / portfolio / open posities."""
from api import db

print("=== Trades per profiel ===")
for p in ["laag", "gemiddeld", "hoog", "extreem"]:
    trades = db.latest_trades(limit=100, profile=p)
    realised = db.realised_pnl_total(p)
    print(f"  {p:10s}: {len(trades)} trades, realised PnL EUR {realised:+.2f}")
    for t in trades[:5]:
        print(f"    - {t['closed_at']}  {t['pair']}  pnl EUR {float(t['pnl']):+.2f}  reason={t['reason']}")

print()
print("=== Laatste portfolio snapshot per profiel ===")
for p in ["laag", "gemiddeld", "hoog", "extreem"]:
    s = db.latest_portfolio_one(p)
    if s:
        print(f"  {p:10s}: cap=EUR {float(s['capital']):.2f}  total=EUR {float(s['total_value']):.2f}  "
              f"market=EUR {float(s['market_value']):.2f}  open={s['open_positions']}  at {s['snapshot_at']}")
    else:
        print(f"  {p:10s}: (geen snapshot)")

print()
print("=== Open posities ===")
opens = db.list_open_positions()
for o in opens:
    print(f"  {o['profile']:10s}: {o['pair']}  entry={float(o['entry_price']):.2f}  size={float(o['size']):.6f}  opened={o['opened_at']}")

print()
print("=== Aantal portfolio snapshots per profiel (laatste 24u) ===")
from datetime import datetime, timedelta, timezone
cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
for p in ["laag", "gemiddeld", "hoog", "extreem"]:
    snaps = db.latest_portfolio(limit=500, profile=p)
    recent = [s for s in snaps if datetime.fromisoformat(s["snapshot_at"].replace("Z", "+00:00")) > cutoff]
    print(f"  {p:10s}: {len(recent)} snapshots in 24u (totaal {len(snaps)})")
