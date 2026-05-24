"""
FastAPI entrypoint.

Aanroepen:
    uvicorn api.main:app --reload --port 8000
of:
    python -m api.main

Het dashboard wordt via dezelfde server geserveerd op http://localhost:8000/
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api.routes import candles, chat, portfolio, positions, signals, status, trades
from config import ROOT

app = FastAPI(title="Trade Bot API", version="0.1.0")

# CORS open — lokale ontwikkeling, dashboard wordt sowieso same-origin geserveerd
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(status.router)
app.include_router(portfolio.router)
app.include_router(positions.router)
app.include_router(trades.router)
app.include_router(signals.router)
app.include_router(candles.router)
app.include_router(chat.router)


# Dashboard static files
DASHBOARD_DIR: Path = ROOT / "dashboard"
if DASHBOARD_DIR.exists():
    # Behoud /static voor backwards compat met oudere paths
    app.mount("/static", StaticFiles(directory=str(DASHBOARD_DIR)), name="static")
    # Serveer dashboard root + relatieve assets (zelfde paths als Vercel deploy)
    app.mount("/dashboard", StaticFiles(directory=str(DASHBOARD_DIR), html=True), name="dashboard")

    @app.get("/")
    def serve_dashboard() -> FileResponse:
        return FileResponse(str(DASHBOARD_DIR / "index.html"))

    # Relatieve script/css requests vanaf "/" — Tailwind/Chart hebben absolute URLs,
    # maar charts.js, chat.js, styles.css worden vanuit dashboard relatief gelinkt
    @app.get("/charts.js")
    def _charts_js() -> FileResponse:
        return FileResponse(str(DASHBOARD_DIR / "charts.js"))

    @app.get("/chat.js")
    def _chat_js() -> FileResponse:
        return FileResponse(str(DASHBOARD_DIR / "chat.js"))

    @app.get("/styles.css")
    def _styles_css() -> FileResponse:
        return FileResponse(str(DASHBOARD_DIR / "styles.css"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api.main:app", host="127.0.0.1", port=8000, reload=True)
