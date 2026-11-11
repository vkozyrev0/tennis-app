"""CourtOps Tennis — Phase 0 API + static frontend.

Run from the backend/ dir:  uvicorn app.main:app --reload
Serves the JSON API under /api and the pure HTML/CSS frontend at /.
"""
import re
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from .config import settings
from .db_errors import install as install_db_error_handlers
from .routers import (
    access_audit,
    adult_lists,
    assignments,
    assignments_bulk,
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
    gmail_feed,
    health,
    hotels,
    imports,
    inbox_feeds,
    inbox_people,
    incidents,
    ingest,
    late_entries,
    me,
    officials,
    outlook_feed,
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
    td_chat,
    tournaments,
    trash,
    users,
    withdrawals,
)
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
          distances, divisions, roster, assignments, assignments_bulk, reports, dashboard, certifications, availability,
          emails, emails_bulk, inbox_people, late_entries, withdrawals, adult_lists, player_hotels,
          pairing_avoidances, doubles, imports, incidents, payroll, staff, trash, retention, users,
          export_audit, access_audit, coppa, td_chat, gmail_feed, outlook_feed, inbox_feeds):
    app.include_router(r.router, dependencies=_admin)

# Disable browser caching of the frontend assets. POC dev loop edits HTML +
# JS + CSS constantly; aggressive Chromium ES-module caching otherwise wins
# even after a hard refresh. For production, replace with hashed filenames
# (e.g. /app.js?v=<git-sha>) and let Cache-Control: immutable do its job.
@app.middleware("http")
async def _limit_request_body(request: Request, call_next):
    """Refuse an oversized API body before FastAPI reads it into memory."""
    from fastapi.responses import JSONResponse

    from .config import MAX_UPLOAD_BYTES
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_UPLOAD_BYTES:
        return JSONResponse(
            status_code=413,
            content={"detail": f"request body too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)"},
        )
    return await call_next(request)


# Frontend assets. `?v=N` is the cache-buster (index.html bumps it per change),
# so a versioned URL can be cached for a year; everything else — notably the
# ES-module graph, whose imports are bare paths — must revalidate so a deploy
# can't leave the browser running a stale module against fresh HTML.
_VERSIONED_ASSET = re.compile(r"(?:^|&)v=[\w.-]+")


@app.middleware("http")
async def _frontend_cache(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api"):
        if _VERSIONED_ASSET.search(request.url.query):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        # StaticFiles never sets these, but a proxy may have.
        for stale in ("pragma", "expires"):
            if stale in response.headers:
                del response.headers[stale]
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
_BUNDLE = _FRONTEND / "dist" / "app.bundle.js"


@app.get("/app.entry.js", include_in_schema=False)
def app_entry(request: Request):
    """One entry script for the SPA.

    The Docker image ships the esbuild bundle (npm run build), so the browser
    makes one script request instead of one per module. A local checkout with
    no frontend/dist gets a one-line loader, keeping development build-free.

    The bundle revalidates with its ETag: Starlette's FileResponse does not
    answer If-None-Match itself, so the check is done here.
    """
    from fastapi.responses import FileResponse, Response

    if _BUNDLE.is_file():
        response = FileResponse(
            _BUNDLE, media_type="text/javascript", stat_result=_BUNDLE.stat(),
        )
        etag = response.headers.get("etag")
        if etag and request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})
        return response
    return Response('import "/app.js";\n', media_type="text/javascript")


if _FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")

# Added last so it is the outermost middleware and compresses every response,
# including the ones the middlewares above touch. The frontend ships ~3 MB of
# unminified JS/CSS; gzip takes the 1.6 MB AG Grid bundle to roughly a quarter.
app.add_middleware(GZipMiddleware, minimum_size=1024)
