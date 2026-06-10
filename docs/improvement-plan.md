# Improvement plan — design + UI/UX review (2026-06-10)

Synthesis of a three-way review: a backend design audit, a frontend code/UX
audit, and a live walkthrough of the running all-in-one image (suite at the
time: **346 green**). Items the [roadmap](roadmap.md) already tracks (blocked
table, Part B phases) are not repeated here. Effort: S ≈ hours, M ≈ a day or
two, L ≈ multi-day.

> **Update (investigation round, later 2026-06-10):** a second pass — gap
> analysis vs the vision, a code-level issue hunt, live API probing, and the
> standalone E2E driver (31/31, zero discoveries) — appended two sections at
> the bottom: **Issues found & fixed** and **P4 — Missing features**.

**How to read this:** P1 are cheap, high-confidence wins that can ship one at a
time in any order. P2 are structural investments that pay off before the next
feature wave. P3 are at-scale items — correct to defer while this is a
single-TD, single-instance POC, and listed so the trigger condition is explicit.

---

## P1 — Quick wins (ship piecemeal) — ✅ ALL SHIPPED (2026-06-10, commit 367868d)

All seven landed in one round: suite 350 green, CI published. Notes from
implementation: the "eight catch-less routers" from the review turned out to be
internally guarded (dedupes / 404 pre-checks / ON DELETE CASCADE), so item 4 is
a safety net for FUTURE constraints rather than a live-bug fix; and item 5's
helper (`query_helpers.paged_select`) is now the adoption path for the
remaining lists (roster, late_entries, withdrawals, doubles, player_hotels,
adult_lists) one endpoint at a time.

1. **Empty-state guidance with prerequisite links** (S) — workspace panels
   assume the Setup catalogs are populated. When `officialsById`/`playersById`
   (etc.) are empty, show a one-line callout in Assignments/Roster/Staff —
   "No officials yet — create them in Setup → Officials" — as a clickable jump.
   The `needs-active-note` pattern covers "pick a tournament" but not "the
   catalog is empty." *Files:* `frontend/app.js` (loadAssignments / loadRoster /
   loadStaff), `frontend/index.html`.

2. **Terminology pass: "Room blocks" vs "Hotel assignment"** (S) — the tab says
   *Room blocks*, the assignment form says *Hotel assignment*, the report says
   *block*. Pick one public label and align tab/form/report/docs. Same pass:
   subtitle "Players catalog" (Setup) vs "this tournament's roster" (workspace)
   so the two player screens stop reading as duplicates. *Files:*
   `frontend/index.html`, `frontend/app.js`, docs.

3. **In-grid edit feedback** (S) — cell PUTs show only the global progress bar;
   a failed save restores the old value (with an error toast) but the cell
   itself never signals. Add a brief saving→saved/error flash on the edited
   cell. *Files:* `frontend/app.js` (cellEdited, ~1641), `frontend/styles.css`.

4. **Consistent 409s for constraint violations** (S) — most writers map
   `UniqueViolation`/`ForeignKeyViolation` → 409 (assignments.py:599,
   divisions.py), but a few swallow or bubble them differently
   (emails.py:204; imports.py catches broad `Exception`). One
   `db_errors.handle_db_conflict` helper, applied uniformly. *Files:* new
   `backend/app/db_errors.py`, the POST/PUT handlers.

5. **Pagination helper + parity** (S→M) — players/officials/emails now share
   the `q`/`limit`/`offset` + `X-Total-Count` pattern but each hand-rolls the
   COUNT + page SQL. Extract `backend/app/query_helpers.paginate(...)`; then
   the remaining big lists (roster, late_entries, withdrawals, doubles,
   player_hotels, adult_lists) adopt it one endpoint at a time, and the grids
   opt in via `wireEntity`'s existing `serverSearch`. *Files:* new helper,
   routers above.

6. **`mark_email_filed` drift point** (S) — single-file flows use the
   `playerops.mark_email_filed` helper; bulk-populate inlines the same UPDATE
   (emails.py ~400). Route bulk through the helper so a future rule change
   (e.g. `filed_at`) can't fork. *Files:* `backend/app/routers/emails.py`.

7. **Event-listener consolidation for comboboxes** (S) — every enhanced select
   registers its own document-level click listener (~46 on a loaded page). One
   delegated document listener routing to the open combo does the same job.
   Not a leak (fixed set), but it's noise on every click and a debugging
   hazard. *Files:* `frontend/app.js` (enhanceSelect).

---

## P2 — Structural (do before the next feature wave)

8. ✅ **SHIPPED (2026-06-10, b21ca10) — Extract the assignment summary into a
   testable module** — `app/assignment_calc.py` now holds the pure calc
   (`mileage_for` / `pay_for` / `compute_summary`); the router keeps only its
   five queries. 15 direct unit tests pin the formula edges (free band, cap
   boundary, missing-distance, soft/hard conflicts, availability semantics).
   Move-only: suite 365 green with the API money tests unchanged.

9. **Split `emails.py` by concern** (M→L) — ✅ **phase 1 SHIPPED** (2026-06-10,
   055d7c5): the six pure text extractors live in `app/email_extract.py` with
   11 direct unit tests (suite 378 green; `_USTA_RE` shared with the roster
   detector, which stays in the router). Remaining (optional): bulk ops →
   their own module if emails.py (now 707 lines) still feels heavy; same
   medicine later for `assignments.py` and `reports.py`.

10. **Savepoint discipline for bulk writes** (M) — imports.py and roster.py
    isolate per-row failures with SAVEPOINTs; bulk-invite / coverage-fill /
    bulk-populate fail-fast instead, so one bad row aborts the batch with no
    partial-success report. Extract the savepoint loop into
    `backend/app/bulk_ops.py` and apply it to every bulk endpoint; tests assert
    "10 rows, 2 bad → 8 succeed + 2 reported."

11. **app.js decomposition, next slices** (M each, L total) — at ~7.5k lines
    with ~40 module-level mutable globals, the monolith is the main frontend
    risk. Don't big-bang it; continue the proven extraction pattern
    (util/shirts/roster_prefill already split): next candidates in value order —
    (a) `grids.js` (wireEntity + list/read grid factories, the largest
    cohesive chunk), (b) `auth.js` (login/session/role-view), (c) an explicit
    `state.js` event for "active tournament changed" so the cascade of reloads
    is declared in one place instead of implicit calls.

12. **Render-template helper for the big card builders** (M) — renderAssignment
    (~250 lines) and friends are string-concat + createElement mixes. A tiny
    tagged-template `html` helper (no framework) makes them readable and
    lintable. Do it together with 11(a) so the extraction doesn't move
    unreadable code.

13. **Soft-delete for Officials / Players / Sites** (M, backend+frontend) —
    hard DELETE loses assignment/pay/distance history on a misclick; the
    confirm dialog doesn't preview cascades. Add `deleted_at`, default-filter
    it, relabel the UI "Archive", add an archived view with restore. Aligns
    with the existing provenance/audit philosophy (pay_audit, player_history).

14. **Response-shape + query-count tests** (S→M) — two cheap test layers that
    harden the API contract: validate key responses against their Pydantic
    models (catches float-vs-string drift), and assert a query-count ceiling on
    the hot list endpoints (catches accidental N+1 in `_summary`-style code).

---

## P3 — At-scale items (defer until the trigger)

| Item | Trigger to act |
|---|---|
| **Connection pooling** (db.py opens one conn per request) | more than ~10 concurrent users, or any multi-worker deploy |
| **Cluster-safe login throttle + sessions** (in-process dicts; per-instance brute-force window; the conftest reset fixture documents the smell) | `uvicorn --workers N` or a second replica |
| **Transaction-isolation review** (default READ COMMITTED everywhere; fine for single-TD, unexamined for concurrent imports to the same tournament) | second concurrent writer on one tournament |
| **Tabulator `renderVertical: "virtual"`** (all grids render every row; "basic" was chosen to dodge a resize-loop bug) | catalogs past ~300 rows; re-test the loop first |
| **Snapshot/audit abstraction** (proactive pay_audit vs lazy USTA backfill are two patterns) | the third audit target appears |
| **CSS utility scale** (inline styles + magic values in JS-built DOM) | next visual-refresh round |

---

## Known-wrong-or-already-done (so they don't resurface)

- *"Failed cell edits revert silently"* — partially false: the catch path does
  raise an error toast (persistent, with close); only the **cell-local** signal
  is missing (item 3).
- *Success-toast duration* — error toasts already persist until dismissed;
  success auto-fade is intentional (WCAG-reviewed). No change planned.
- Empty-state for "no active tournament", inline add-distance, assignment-card
  layout, ARIA tabs, mobile nav, server paging for inbox/players/officials —
  **already shipped**; see roadmap "UI review & backlog" ✅ marks.

## Suggested sequencing

1. **Round 1 (a day):** items 1–7 — all S, independently shippable, user-visible
   or contract-tightening.
2. **Round 2:** item 8 (assignment calc + unit tests) → item 14 (shape/query
   tests) — locks down the money path before anything else moves.
3. **Round 3:** items 9–10 (emails split + bulk savepoints) — Part B robustness.
4. **Round 4:** items 11–12 (frontend decomposition + templates), then 13
   (soft-delete) as the first feature built on the cleaner base.
5. P3 stays parked until its trigger column fires.

---

# Investigation round (2026-06-10, second pass)

Method: a missing-features gap analysis against [vision-summary](vision-summary.md)/
[audit](audit.md)/the route+UI surface, a code-level issue hunt, live API edge
probing against the running container, and the standalone E2E driver
(`scripts/e2e_td_scenario.py` — **31/31 checks, zero discoveries**).

## Issues found & fixed (same day)

| # | Issue | Severity | Fix |
|---|---|---|---|
| I-1 | **ILIKE wildcard leak** — a user searching for `%` or `_` matched *every* row (the SQL wildcards passed through `q` unescaped) on players/officials/emails lists AND both `/search` endpoints | med | `query_helpers.like_escape()` applied at all six sites; tests assert `%`/`_____` match 0 |
| I-2 | **`_rate_for` future-rate fallback** — work logged on a date BEFORE any rate's `effective_from` was paid at the *newest* rate ever created; now falls back to the *earliest* known rate (nearest to that early work date) | high (edge) | `ORDER BY effective_from ASC` in the fallback + `test_zz_rate_fallback.py` (rolled-back txn) |
| I-3 | **`esc()` hygiene** — four innerHTML sites interpolated `e.row`/`c.row`/`total_active` unescaped (numbers today; defense-in-depth) | low | wrapped in `esc()` |

Probes that came back clean: unauthenticated access to players/ics endpoints
(401s), negative/huge `limit`/`offset` (clamped; `X-Total-Count` correct),
room-capacity TOCTOU (serialized per-request txn), parameterized ILIKE
(no injection), float money rounding (2dp by design).

## False-positive ledger (round 2)

Claims from the gap analysis verified ALREADY BUILT — listed so they don't
resurface: roster-completeness report (`/roster-completeness` + UI), one-click
alternate promotion (`POST /api/roster/{id}/promote` + sorted alternates list),
t-shirt counts by site (`/tshirts-by-site` + UI, B1 shipped), sign-in sheet
(print + CSV exports exist; only the in-app check-in toggle is missing — see
P4-2), room-block pickup/attrition report (reserved vs assigned vs unused).
From the issue hunt: emails-list ILIKE was already parameterized (the wildcard
leak was real but injection was not).

## P4 — Missing features (verified gaps, by value to a live event)

Day-of-tournament operations is the one genuinely unbuilt AREA — everything
before (planning/staffing) and after (reports/statements) an event is covered,
but the app has no live-operations surface:

1. **Official day-of status** (M) — no-show / early-departure / reassigned on an
   assignment day; feeds payroll truth and a live staffing view. The records
   exist; only planned-vs-actual is missing.
2. **Player check-in** (S) — `signed_in` column exists (0028) and sign-in sheets
   print, but there's no in-app toggle or no-show report.
3. **Incident log** (M) — day-of operational memory (weather, injury, dispute);
   no table/UI today. Pairs naturally with 1.
4. **Payroll finalization** (M) — an approved/paid state over the existing pay
   statements + a payroll CSV batch export; today statements print but nothing
   records that they were settled.
5. **Assignment change audit** (M) — pay_audit freezes amounts, but who/why for
   assignment edits isn't recorded (dispute resolution).
6. **Official self-service dietary/lodging** (S) — portal lets officials set
   availability but not update dietary/lodging; the TD re-keys those.
7. **Per-site coordinator role** (L) — D8 deferred multi-user; becomes relevant
   with 3+ venue events.
8. **Configurable mileage/cert catalogs** (M, low value now) — constants are
   fine for a single TD; revisit if other organizations adopt the tool.

Known blockers (unchanged, tracked in the roadmap): mail send/ingest infra,
Maps API key, LLM-triage privacy decision, PII H2 at deploy, USTA draw API
(intentionally out of scope, D7).
