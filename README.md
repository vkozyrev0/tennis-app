# CourtOps Tennis

[![docker](https://github.com/vkozyrev0/tennis-app/actions/workflows/docker.yml/badge.svg)](https://github.com/vkozyrev0/tennis-app/actions/workflows/docker.yml)
[![Docker Hub](https://img.shields.io/docker/image-size/vkozyrev0/tennis-app/latest?logo=docker&label=docker%20hub)](https://hub.docker.com/r/vkozyrev0/tennis-app)

Back-office tooling for a USTA **Tournament Director (TD)**. Two loosely-coupled
halves:

- **Officials & staffing** — officials declare availability; the TD invites and
  assigns them per day/role across venues, tracks accept/decline, lodging, and
  computes pay + mileage. Reports, conflict checks, and a readiness scorecard
  keep an event on track.
- **Player operations (Part B)** — a human-reviewed **inbox** where parent/player
  email is triaged (classify → detect players/partners/USTA #s → file, with
  manual assignment when detection can't match) into structured lists: roster, late
  entries, withdrawals, scheduling avoidances, division flexibility, doubles,
  pairing avoidances, player hotels, and t-shirt orders.

Single-page admin tool with a **Setup catalog** (durable master data) and a
**per-tournament workspace** (scoped operations), plus a small **self-service**
surface for officials.

## Stack

**Postgres 16** (Docker) · **FastAPI + psycopg 3** (Pydantic) · **vanilla
HTML/CSS/JS** frontend (no build step; **AG Grid Community 32.3.5** vendored — the
only third-party frontend lib). POC auth defaults to `admin / admin` — harden
before any shared deployment.

## Run it in one container (Postgres + server + website)

The whole POC — database, API, and frontend — runs from a single image. Pull the
prebuilt image from Docker Hub (no clone/build needed):

```bash
docker run --rm -p 8000:8000 vkozyrev0/tennis-app:latest
# open http://localhost:8000 — sign in as admin / admin
```

Or build it yourself from a checkout:

```bash
docker build -t courtops:poc .
docker run --rm -p 8000:8000 courtops:poc
```

The realistic demo (Macon Junior Open 2026) is **seeded at build time and baked
into the image's database**, so it's there the instant the container starts —
the container just boots Postgres and serves the API + site on :8000. Useful env
vars: `DEMO_RESEED=1` regenerates the demo on start (fresh, today-relative
dates), `SEED_SCRIPT=seed.py` uses the lean baseline, `PORT` changes the port.
The baked DB lives at `/opt/courtops/pgdata`; mount a volume there to persist
changes across runs. This bundles the DB + data into the app image for demo
convenience — not a production topology (see [docs/design.md](docs/design.md) §11).

## Local dev (without Docker)

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate      # Unix: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                                # edit PG* if needed
python migrate.py                                   # create + migrate the `courtops` DB
python seed.py                                      # baseline: admin user, rates, players
uvicorn app.main:app --reload --port 8000           # API at /api + frontend at /
# open http://localhost:8000 — sign in as admin / admin
```

### A realistic demo to click around

```bash
cd backend && .venv/Scripts/python.exe demo_seed.py
```

Wipes and loads a believable **live** event (Macon Junior Open 2026): a staffed
crew, a full roster, lodging, an active inbox, and a few problems to resolve — so
every screen opens to lifelike activity. Official demo logins use password
`official` (e.g. `jwhitfield`). `reset_demo.py` restores just the lean baseline.

## Tests

```bash
cd backend && python -m pytest -q                   # full suite (deterministic)
```

`tests/test_td_e2e.py` walks the whole TD workflow at the API boundary.
`tests/test_zz_*.py` are per-feature suites (sorted last to avoid login races).

### Live server scripts (uvicorn must already be running)

```bash
backend/.venv/Scripts/python.exe scripts/ux_walkthrough.py
backend/.venv/Scripts/python.exe scripts/live_feature_smoke.py
backend/.venv/Scripts/python.exe scripts/e2e_td_scenario.py [--write-findings]
```

- **`e2e_td_scenario.py`** — full TD workflow + manufactured challenges (see [docs/e2e-findings.md](docs/e2e-findings.md)).
- **`ux_walkthrough.py`** — admin + official portal API walk + static assets.
- **`live_feature_smoke.py`** — SPA module checks + day-of / official / import fix surface.

Run them **one at a time** (parallel logins can trip the process-local throttle).

## Docs

Start at **[docs/README.md](docs/README.md)**. For how it's built — architecture,
patterns, domain rules, and a from-scratch rebuild order — see
**[docs/design.md](docs/design.md)** (paired with `data-model.md` for the schema).
