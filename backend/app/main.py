"""CourtOps Tennis — Phase 0 API + static frontend.

Run from the backend/ dir:  uvicorn app.main:app --reload
Serves the JSON API under /api and the pure HTML/CSS frontend at /.
"""
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.staticfiles import StaticFiles

from .routers import (
    access_audit,
    adult_lists,
    assignments,
    auth,
    availability,
    certifications,
    coppa,
    dashboard,
    distances,
    divisions,
    doubles,
    emails,
    emails_bulk,
    export_audit,
    health,
    hotels,
    imports,
    incidents,
    ingest,
    late_entries,
    me,
    officials,
    pairing_avoidances,
    payroll,
    player_hotels,
    players,
    rates,
    reports,
    retention,
    room_blocks,
    roster,
    sites,
    staff,
    tournaments,
    trash,
    users,
    withdrawals,
)
from .config import settings
from .db_errors import install as install_db_error_handlers
from .security import require_admin
from .security_headers import build_security_headers, security_headers_enabled

# PII hardening H1: refuse to start a shared/hosted deployment that still carries
# the POC defaults (superuser creds / no TLS). No-op in dev/test.
# See docs/pii-hardening-plan.md §H1.
settings.validate()

app = FastAPI(title="CourtOps Tennis API", version="0.4.0")

# Safety net: any UNCAUGHT psycopg constraint violation maps to 409/400 with a
# readable detail instead of a bare 500. Routers with tailored messages keep
# them (their try/except runs first). See app/db_errors.py.
install_db_error_handlers(app)

# Open endpoints: health + auth (login) + the official self-service surface
# (which checks the session itself) + email auto-ingest (token-gated, not cookie).
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(ingest.router)

# Admin-only: every TD/back-office router requires an admin session.
_admin = [Depends(require_admin)]
for r in (sites, tournaments, officials, players, rates, hotels, room_blocks,
          distances, divisions, roster, assignments, reports, dashboard, certifications, availability,
          emails, emails_bulk, late_entries, withdrawals, adult_lists, player_hotels,
          pairing_avoidances, doubles, imports, incidents, payroll, staff, trash, retention, users,
          export_audit, access_audit, coppa):
    app.include_router(r.router, dependencies=_admin)

# Disable browser caching of the frontend assets. POC dev loop edits HTML +
# JS + CSS constantly; aggressive Chromium ES-module caching otherwise wins
# even after a hard refresh. For production, replace with hashed filenames
# (e.g. /app.js?v=<git-sha>) and let Cache-Control: immutable do its job.
@app.middleware("http")
async def _no_cache_frontend(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# D17: baseline security headers (CSP, framing, MIME sniffing, referrer).
# Runs on API + static responses. HSTS only when ENV=prod or COURTOPS_HSTS=1.
@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    if security_headers_enabled():
        for name, value in build_security_headers(is_prod=settings.is_prod()).items():
            # Don't clobber a more specific value set by a route or outer proxy.
            if name not in response.headers:
                response.headers[name] = value
    return response


# Serve the pure HTML/CSS frontend (repo-root/frontend) at "/".
_FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
if _FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
