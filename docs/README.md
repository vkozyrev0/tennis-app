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

| # | File | Purpose |
|---|------|---------|
| 1 | [vision-summary.md](vision-summary.md) | The TD's product vision, normalized. Stable anchor. |
| 2 | [design.md](design.md) | **Architecture & rebuild guide** — structure, patterns, and domain rules; enough to recreate the app. |
| 3 | [data-model.md](data-model.md) | Current schema + entity relationships, kept current with migrations. |
| 4 | [roadmap.md](roadmap.md) | What's shipped, what's open. |
| 5 | [improvement-plan.md](improvement-plan.md) | Prioritized design + UI/UX review findings (P1 quick wins → P3 at-scale, plus P4 missing features), with shipped marks and sequencing. |
| 6 | [changelog.md](changelog.md) | Chronological log of shipped work. |
| 7 | [test-coverage.md](test-coverage.md) | Per-test inventory: what each test exercises, what type it is, what scenario it simulates. |
| 8 | [deploy.md](deploy.md) | Publish (ghcr) + host (Fly/Render/VM) the all-in-one image; TLS and persistence semantics. |
| 9 | [pii-hardening-plan.md](pii-hardening-plan.md) | PII hardening plan for minors' data (COPPA): inventory, obligations, phased remediation. |
| 10 | [pii-h2-key-management.md](pii-h2-key-management.md) | H2 PII key-management & rotation design (Fernet MultiFernet, re-encrypt backfill, deploy runbook). |
| 11 | [e2e-findings.md](e2e-findings.md) | Standalone end-to-end scenario driver (`scripts/e2e_td_scenario.py`): coverage, findings, run log. |
| 12 | [audit.md](audit.md) | Historical register from the original TD audit (D1–D8). Archived — all items resolved. |
| 13 | [email-ingest.md](email-ingest.md) | Auto-ingest webhook (D4): token auth, routing, provider sketches. |

## Quickstart

```bash
# Backend
cd backend
python -m venv .venv && source .venv/Scripts/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # edit PG* settings if needed
python migrate.py                                      # creates + migrates `courtops`
python seed.py                                         # idempotent baseline: admin, rates, players
uvicorn app.main:app --reload --port 8000              # serves API at /api + frontend at /

# Then open http://localhost:8000 and sign in with: admin / admin
```

Frontend has no build step — it's pure HTML/CSS/JS served straight from
`frontend/`. AG Grid Community 32.3.5 is vendored.

For a believable **live** demo to click around (staffed event, full roster,
active inbox, problems to resolve), run `python demo_seed.py` from `backend/`.
`reset_demo.py` restores just the lean baseline (both preserve the
migration-seeded division/event/rate catalogs).

## Tests

```bash
cd backend
python -m pytest -q                                    # full suite (deterministic)
```

`test_td_e2e.py::test_td_full_workflow` walks the full TD workflow at the API
boundary. `test_zz_*.py` are per-feature suites (named to sort last so their
admin logins don't race a still-running module). For a black-box end-to-end run
against a live server, see [e2e-findings.md](e2e-findings.md).

## Status

The original TD audit (D1–D8) is closed. Subsequent code/UX
critique passes are closed; the running findings register is
folded into `changelog.md`. The 2026-06-10 improvement plan's P1 round
and most P2/P4 items are shipped (P2 #8 + #10–14 and #9 phase 1; all P4
day-of + payroll work — only the deferred at-scale P4-7/P4-8 remain) —
see `improvement-plan.md` for the per-item marks. Active open items live
in `roadmap.md` under "Open work".

POC stack: **Postgres** (localhost) · **FastAPI + psycopg3** · **vanilla
HTML/CSS/JS**. The POC defaults to `admin/admin`; harden before any
shared deployment (see roadmap §Stack security note).
