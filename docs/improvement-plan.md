# Improvement plan — design + UI/UX review (2026-06-10)

Synthesis of a three-way review: a backend design audit, a frontend code/UX
audit, and a live walkthrough of the running all-in-one image (suite at the
time: **346 green**). Items the [roadmap](roadmap.md) already tracks (blocked
table, Part B phases) are not repeated here. Effort: S ≈ hours, M ≈ a day or
two, L ≈ multi-day.

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

8. **Extract the assignment summary into a testable module** (M) — `_summary()`
   (assignments.py:54–234) is the single source of truth for pay / mileage /
   conflict / availability flags, ~180 lines, exercised only through API tests
   from 6+ call sites. Move the calculation to `backend/app/assignment_calc.py`
   with direct unit tests; routers keep the DB load + serialization. *This is
   the highest-leverage backend item* — money logic deserves unit tests.

9. **Split `emails.py` (745 lines) by concern** (M→L) — inbox list/search,
   triage, bulk ops, amendments, and the regex extractors live in one file.
   Extractors → `email_extract.py` first (pure functions, instantly
   unit-testable), then bulk ops if it still feels heavy. Same medicine later
   for `assignments.py` (825) and `reports.py` (404).

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
