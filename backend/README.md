# CourtOps Tennis — Backend (Phase 0 + Phase 1 in progress)

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
.\.venv\Scripts\python.exe -m pytest -q   # 34 end-to-end tests; skips if Postgres is down
```
Tests run against a **separate `courtops_test` database** (created/migrated/seeded
automatically by `tests/conftest.py`), so they never pollute the working DB.

## Reset the demo data
```powershell
.\.venv\Scripts\python.exe reset_demo.py  # wipe all rows in courtops, then re-seed
```

## Backfill officials + distances from the workbook
```powershell
.\.venv\Scripts\python.exe backfill_distances.py  # reads ../Officials Mileage Workbook.xlsx
```
Imports officials and their official↔site distances (one-way = `(reimbursable+50)/2`),
skipping the `182` placeholder and blank cells (audit §3.7).

## Layout
```
backend/
  app/
    config.py          env-based settings (PG* vars)
    db.py              psycopg connection + FastAPI dependency
    models.py          pydantic request/response models
    main.py            FastAPI app; mounts API + static frontend
    security.py        pbkdf2 hashing + cookie-session auth dependencies
    triage.py          local rule-based email classifier (agent v0, no LLM)
    routers/           health, auth (login/logout/me), me (official self-service),
                       sites, tournaments (+ /sites M2M), officials (+ /account),
                       players (+ /history), rates, hotels, room_blocks, distances,
                       roster (+ CSV/XLSX import), assignments (+ days, pay/mileage),
                       reports, certifications, availability,
                       emails (review inbox + /suggest triage), late_entries, withdrawals,
                       adult_lists (scheduling avoid. + division flex),
                       player_hotels (+ CVB analytics + /tshirts list),
                       pairing_avoidances (juniors, group of 2+),
                       doubles (mutual verification + random queue)
  migrations/          0001_core_schema, 0002_rates_hotels,
                       0003_mappings_assignments, 0004_player_history,
                       0005_assignment_snapshots, 0006_certifications,
                       0007_availability, 0008_auth, 0009_certification_types,
                       0010_room_block_kind, 0011_player_ops, 0012_withdrawals,
                       0013_avoid_divflex, 0014_player_hotels, 0015_pairing_avoidances,
                       0016_doubles, 0017_session_expiry
  migrate.py           migration runner (creates DB, tracks schema_migrations)
  seed.py              demo data (sites, a tournament + site link, cert rates)
  reset_demo.py        wipe + re-seed the working DB
  backfill_distances.py  import officials + distances from the mileage workbook
  tests/conftest.py    points the suite at courtops_test (isolation)
  tests/test_smoke.py  end-to-end smoke tests (34; admin-authenticated)
frontend/              index.html, styles.css, app.js (vanilla fetch, no framework)
```

## Frontend structure
Two areas (see `app.js`), pure HTML/CSS + vanilla JS:
- **Setup** (persistent master data): Tournaments catalog, Sites, Officials,
  Players, Rates, Hotels, Distances, T-shirts — generic master-detail CRUD with
  per-row Edit/Delete and a client-side filter. The **list is the wide column**
  (form bounded, sticky); stacks to a full-width list under 980px.
- **Tournament workspace**: an **active tournament** chosen in the context bar
  (persisted in `localStorage`) scopes labeled nav sub-areas — **Tournament**
  (Sites/Roster/Availability), **Staffing** (Assignments/Room blocks/Reports),
  **Player requests** (review Inbox + late entries, withdrawals, scheduling,
  division flex, pairing avoidances, doubles, player hotels). Workspace add-forms
  are collapsible (`<details>`, closed by default; auto-open on file/edit).

UX: status **color chips**, corner **toasts**, a styled **confirm modal**, a
global request **progress bar**, busy-on-submit, **CSV export** + **CSV template**
(empty, headers-only — roster's matches the importer's fields) per list, keyboard
**ARIA tablist** + `:focus-visible`, zebra/sticky tables, right-aligned numerics.
Navigation is a **two-level menu** — a level-1 bar of sections (Setup / Tournament
/ Staffing / Player requests) reveals only the chosen group's tabs — and every
`<select>` is a **type-in searchable dropdown** (native select kept as the form's
source of truth; no JS dependency). Staffing and Player-request forms **reference
the existing Officials / Players lists** via these pickers rather than re-typing a
person; the chosen player is resolved back to USTA #/name on submit (backend
upsert-by-USTA # unchanged).
Setup lists each have **their own scrollbar** (`.list-scroll` container, pinned
header) whose height is **bounded to the viewport dynamically** (a `sizeLists()`
helper sets `--list-max` from the list's real top offset on tab-switch/resize/load),
so a long list never pushes the sticky edit form out of view or runs off the
bottom of the screen. Each detail form has **Prev / Next record navigation**
(`‹ Prev · N / total · Next ›`) that steps through the filtered list without
scrolling. The toolbar/header are **condensed** for vertical density.

## Scope status
- **Phase 0** ✅ — core schema + CRUD foundations.
- **Phase 1** 🚧 — sites/tournaments/officials/players/rates/hotels CRUD,
  tournament↔site M2M, roster (with **player history** + point-in-time names),
  hotel/room-block split, **assignments with per-day roles + pay/mileage**, and
  the **officials confirmation & pay report** (print + CSV), **room-count
  enforcement**, **pay/mileage snapshots** (audit §5.3), the **distance backfill**,
  **roster CSV/XLSX import**, **official certifications** (role-constrained), and
  **TD-entered availability**, **auth + officials self-service** (login,
  `admin`/`official` roles, `/api/me/*`), and the start of **Part B** (review
  **Inbox** + **Late entries** + **Withdrawals**, **Scheduling avoidances**, **Division flexibility**, **Player hotels** + CVB analytics, and the cumulative **T-shirt** list, **Pairing avoidances** (juniors), and **Doubles** (mutual + random) — **all Part B lists** — with file-from-email) are done — availability is surfaced in the Assignments picker and a local
  rule-based triage **/suggest** proposes a classification. **Remaining:**
  auto-distance (geocoding), real email auto-ingest, and the **LLM** upgrade of the
  triage agent (the open **D5** call). (All Part B lists are built, each
  with **CSV export**.) See `docs/roadmap.md` and `docs/data-model.md` markers.

**Login (POC):** `admin` / `admin` (seeded). Admins set an official's login from
the Official detail; officials then sign in to a self-service profile + availability
view. Sessions are HttpOnly cookies — harden before any shared deployment.

> **Security (POC only):** localhost Postgres on default admin creds is for local
> development. Before any shared deployment, switch to a least-privilege DB user
> with a secret from the environment, plus TLS (`docs/roadmap.md` §Stack).
