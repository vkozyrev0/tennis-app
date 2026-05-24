# CourtOps Tennis — Backend (Phase 0)

POC stack: **PostgreSQL** + **Python API (FastAPI)** + **pure HTML/CSS** frontend.
No agent/LLM (player email is human-reviewed — see `docs/audit.md` §5.1).

## Prerequisites
- PostgreSQL running on `localhost:5432` (POC uses the default `postgres` admin
  user). Override via `backend/.env` (copy from `.env.example`).
- Python 3.11+.

## Setup
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Database
```powershell
.\.venv\Scripts\python.exe migrate.py   # creates the courtops DB + applies schema
.\.venv\Scripts\python.exe seed.py      # optional demo data (idempotent)
```
`migrate.py` is a tiny runner: it creates the database if missing, then applies any
new `migrations/*.sql` (tracked in `schema_migrations`).

## Run
```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```
- App / UI:   http://localhost:8000/
- API docs:   http://localhost:8000/docs
- Health:     http://localhost:8000/api/health

## Test
```powershell
.\.venv\Scripts\python.exe -m pytest -q   # smoke test; skips if Postgres is down
```

## Layout
```
backend/
  app/
    config.py          env-based settings (PG* vars)
    db.py              psycopg connection + FastAPI dependency
    models.py          pydantic request/response models
    main.py            FastAPI app; mounts API + static frontend
    routers/           health, sites, tournaments
  migrations/          numbered *.sql (0001_core_schema.sql)
  migrate.py           migration runner
  seed.py              demo data
  tests/test_smoke.py  end-to-end smoke test
frontend/              index.html, styles.css, app.js (vanilla fetch)
```

## Phase 0 scope (done)
Core schema — `site`, `tournament`, `official`, `player`, `tournament_entry` — and
a thin slice of the Phase 1 admin tool: create/list sites and tournaments. Next:
the rest of Phase 1 (certification rates, hotel blocks, assignments with per-day
roles, pay/mileage, reports) per `docs/roadmap.md`.

> **Security (POC only):** localhost Postgres on default admin creds is for local
> development. Before any shared deployment, switch to a least-privilege DB user
> with a secret from the environment, plus TLS (`docs/roadmap.md` §Stack).
