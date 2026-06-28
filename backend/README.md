# CourtOps Tennis — Backend

POC stack: **PostgreSQL 16** + **FastAPI** (psycopg 3, raw SQL, Pydantic) + a
vanilla-JS frontend served by the same app. No ORM, no agent/LLM (player email is
human-reviewed — see [docs/audit.md](../docs/audit.md) §5.1).

> This file is the **quickstart only**. The canonical docs live in
> [`docs/`](../docs/): architecture in [design.md](../docs/design.md), schema in
> [data-model.md](../docs/data-model.md), build order in
> [roadmap.md](../docs/roadmap.md), routers/migrations/test inventory there too —
> kept current so this README doesn't drift.

## Prerequisites
- A PostgreSQL 16 server on `localhost:5432` reachable as the `postgres`
  superuser (POC default). Override any of `PG{HOST,PORT,USER,PASSWORD,DATABASE}`
  via `backend/.env`. (On a machine where 5432 is reserved — e.g. Docker/WinNAT
  excludes the 5381–5480 range — set `PGPORT` in `backend/.env` to a free port.
  This repo's local dev uses `PGPORT=5544`.)
- Python 3.11+.

## Setup
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Database + run
```powershell
.\.venv\Scripts\python.exe migrate.py     # create courtops DB + apply migrations/*.sql
.\.venv\Scripts\python.exe demo_seed.py   # rich demo data (or seed.py for the lean baseline)
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```
- App / UI:  http://localhost:8000/  (sign in: `admin` / `admin`)
- API docs:  http://localhost:8000/docs
- Health:    http://localhost:8000/api/health

`migrate.py` creates the database if missing, then applies any pending
`migrations/*.sql` (tracked in `schema_migrations`).

## Test
```powershell
.\.venv\Scripts\python.exe -m pytest -q   # runs against a separate courtops_test DB
```
`tests/conftest.py` drops, recreates, migrates and seeds `courtops_test` per
session, so a run is hermetic and never touches the working DB. (Skips/fails fast
if Postgres is unreachable.)

## All-in-one Docker image
The shipped artifact bundles **Postgres + the API + the frontend in one
container** (DB baked at build time). See [docs/deploy.md](../docs/deploy.md):
```powershell
docker build -t courtops:poc .
docker run --rm -p 8000:8000 courtops:poc   # http://localhost:8000  (admin/admin)
```

## Security (POC only)
localhost Postgres on default admin creds is for local dev (`ENV=dev`). With
`ENV=prod` the app **refuses to start** on the default `postgres`/`postgres`
creds, a non-TLS `PGSSLMODE`, or the dev PII encryption key
(`app/config.py::Settings.validate()`). Full plan:
[docs/pii-hardening-plan.md](../docs/pii-hardening-plan.md) §H1.
