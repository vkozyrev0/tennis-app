# CourtOps — End-to-End Scenario Findings

A standalone driver, **`scripts/e2e_td_scenario.py`**, simulates a Tournament
Director's full workflow against a live server and checks that the challenges a
TD hits surface where they'd look. This file records what it covers and what
running it taught us.

## Running it

```bash
# server must be running (e.g. the dev/preview server on :8000)
backend/.venv/Scripts/python.exe scripts/e2e_td_scenario.py [--base-url URL] [--write-findings]
```

It's an **external HTTP client** (doesn't import the app), so it can point at any
instance. It prefers `httpx` (in the backend venv) and falls back to stdlib
`urllib`. Every row it creates is tagged `E2E <run>` and left in the DB for
inspection (safe on a dev DB; don't point it at production). Exit code is non-zero
if any check fails, so it can gate CI.

## What the scenario exercises

Setup → officials (certs / logins / availability) → **roster CSV import**
(complete + incomplete rows) → **Part-B inbox triage** (classify → detect →
populate) → **bulk-invite** → assignments with deliberately manufactured
challenges → **self-service accept/decline** → **withdrawal → promote alternate**
→ then verifies each challenge surfaces in the TD's review surfaces:

| Manufactured challenge | Surfaces in |
|---|---|
| A play day with no official | readiness (fail), dashboard uncovered-days, coverage-candidates → one-click fill |
| Cross-tournament double-booking (different site, same day) | readiness (fail), conflict report (hard) |
| Uncertified worked day (no-cert official) | readiness (fail), conflict report |
| Declined assignment | readiness (fail), declined-alert list |
| Withdrawal | alternate suggestion → promote |
| Official↔site with no mileage distance | missing-distance report |
| Assigned official with no login | officials-without-login banner |
| Dietary restriction / lodging | dietary summary / rooming list |
| Pay + mileage | per-official + batch pay statements |
| Cross-tournament load & deadlines | workload, digest, deadline radar |

**Latest result: 31/31 checks pass, 0 discoveries** — every challenge is caught
where the TD would look. This is an end-to-end validation of the session's
feature work against a realistic, messy tournament.

## Findings & follow-ups

- **F1 — Mileage reads `$0.00` for short distances, which looks like a bug.**
  The reimbursement rule is `clamp((2·oneway − 50)·0.65, 0, 100)` — the first 50
  round-trip miles are free, so any one-way distance ≤ 25 mi computes to **$0**
  *even though a distance is on file*. A TD seeing "$0.00" next to a known
  distance can mistake it for a missing/broken calc.
  **Action taken:** the assignment card + pay statements now show a
  *"within the first 50 free miles"* hint when mileage is $0 with a distance on
  file (not the same as the "no distance" state). See changelog.

- **F2 — Roster import reports rows-merged per row, not per distinct player.**
  Uploading 3 rows that share a USTA # upserts to one player (by design — USTA #
  is the identity key) but the summary says "merged 3". Correct per-row, but worth
  knowing it counts rows, not players. No change; documented to avoid confusion.
  (This also bit the driver itself: an early version truncated generated USTA #s
  so all test players collided — a good reminder that USTA # is the merge key.)

- **F3 — Auto-triage only files emails it can match to a roster player.**
  Of 5 inbound emails, triage classified 5, matched 3, filed 2: the hotel + the
  general question carry no USTA # so they can't be auto-matched/filed, and a
  doubles request is single-file-only (needs partner data). Expected — the
  **unmatched drilldown** and the per-classification forms catch the rest. Not a
  gap; documented so the "filed < received" delta isn't misread.

- **F4 — The driver needs `httpx` on Windows.** Plain `urllib` POSTs reset
  intermittently against uvicorn on Windows (curl/httpx don't); the script prefers
  `httpx` and only retries idempotent GETs so a reset can never duplicate a write.

---

## Run log
<!-- `--write-findings` appends a dated one-line summary per run below. -->

## E2E run 43dcf5 — 2026-06-06

- Target: `http://localhost:8000` · tournaments 36 (junior) + 37 (adult).
- Checks: **31 passed, 0 failed**; 0 discovery(ies).
- No discoveries — every challenge surfaced where expected.

## E2E run 912223 — 2026-06-06

- Target: `http://localhost:8000` · tournaments 40 (junior) + 41 (adult).
- Checks: **31 passed, 0 failed**; 0 discovery(ies).
- No discoveries — every challenge surfaced where expected.
