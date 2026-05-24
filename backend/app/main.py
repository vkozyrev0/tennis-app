"""CourtOps Tennis — Phase 0 API + static frontend.

Run from the backend/ dir:  uvicorn app.main:app --reload
Serves the JSON API under /api and the pure HTML/CSS frontend at /.
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .routers import (
    assignments,
    distances,
    health,
    hotels,
    officials,
    players,
    rates,
    room_blocks,
    roster,
    sites,
    tournaments,
)

app = FastAPI(title="CourtOps Tennis API", version="0.3.0")

# API routers first so they take precedence over the catch-all static mount.
app.include_router(health.router)
app.include_router(sites.router)
app.include_router(tournaments.router)
app.include_router(officials.router)
app.include_router(players.router)
app.include_router(rates.router)
app.include_router(hotels.router)
app.include_router(room_blocks.router)
app.include_router(distances.router)
app.include_router(roster.router)
app.include_router(assignments.router)

# Serve the pure HTML/CSS frontend (repo-root/frontend) at "/".
_FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
if _FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
