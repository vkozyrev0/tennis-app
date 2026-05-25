"""CourtOps Tennis — Phase 0 API + static frontend.

Run from the backend/ dir:  uvicorn app.main:app --reload
Serves the JSON API under /api and the pure HTML/CSS frontend at /.
"""
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles

from .routers import (
    adult_lists,
    assignments,
    auth,
    availability,
    certifications,
    distances,
    doubles,
    emails,
    health,
    hotels,
    imports,
    late_entries,
    me,
    officials,
    pairing_avoidances,
    player_hotels,
    players,
    rates,
    reports,
    room_blocks,
    roster,
    sites,
    tournaments,
    withdrawals,
)
from .security import require_admin

app = FastAPI(title="CourtOps Tennis API", version="0.4.0")

# Open endpoints: health + auth (login) + the official self-service surface
# (which checks the session itself).
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(me.router)

# Admin-only: every TD/back-office router requires an admin session.
_admin = [Depends(require_admin)]
for r in (sites, tournaments, officials, players, rates, hotels, room_blocks,
          distances, roster, assignments, reports, certifications, availability,
          emails, late_entries, withdrawals, adult_lists, player_hotels,
          pairing_avoidances, doubles, imports):
    app.include_router(r.router, dependencies=_admin)

# Serve the pure HTML/CSS frontend (repo-root/frontend) at "/".
_FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
if _FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
