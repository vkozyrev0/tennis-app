# CourtOps Tennis — Documentation

Back-office tooling for a USTA Tournament Director. Two loosely-coupled halves:

- **Officials app** — officials declare availability; the TD confirms
  assignments, lodging, and computes pay + mileage.
- **Player operations** — a **review inbox** where parent/player email
  is human-reviewed and filed into structured lists (roster, late
  entries, withdrawals, scheduling avoidances, division flex, doubles,
  pairing avoidances, player hotels, t-shirts).

The app is a single-page admin tool with a Setup catalog (durable
master data) and a per-tournament workspace (scoped operations).

## Docs

| File | Purpose |
|------|---------|
| [vision-summary.md](vision-summary.md) | The TD's product vision, normalized. Stable anchor. |
| [data-model.md](data-model.md) | Current schema + entity relationships, kept current with migrations. |
| [roadmap.md](roadmap.md) | What's shipped, what's open. |
| [changelog.md](changelog.md) | Chronological log of shipped work. |
| [test-coverage.md](test-coverage.md) | Per-test inventory: what each test exercises, what type it is, what scenario it simulates. |
| [audit.md](audit.md) | Historical register from the original TD audit (D1–D8). Archived — all items resolved. |

## Quickstart

```bash
# Backend
cd backend
python -m venv .venv && source .venv/Scripts/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # edit PG* settings if needed
python migrate.py                                      # creates + migrates `courtops`
python seed.py                                         # idempotent: admin user, rates, demo data
uvicorn app.main:app --reload --port 8000              # serves API at /api + frontend at /

# Then open http://localhost:8000 and sign in with: admin / admin
```

Frontend has no build step — it's pure HTML/CSS/JS served straight from
`frontend/`. Tabulator 6.3.1 is vendored.

## Tests

```bash
cd backend
python -m pytest -q                                    # 54 tests including test_td_e2e.py
```

`test_td_e2e.py::test_td_full_workflow` walks the full TD workflow at
the API boundary — useful as both a smoke test and a worked example
of every shipped feature.

## Status

The original TD audit (D1–D8) is closed. Eight subsequent code/UX
critique passes are also closed; the running findings register is
folded into `changelog.md`. Active open items live in `roadmap.md`
under "Open work".

POC stack: **Postgres** (localhost) · **FastAPI + psycopg3** · **vanilla
HTML/CSS/JS**. The POC defaults to `admin/admin`; harden before any
shared deployment (see roadmap §Stack security note).
