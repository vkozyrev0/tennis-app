# CourtOps Tennis — Test Coverage

**Suite:** `backend/tests/` · **Runner:** `python -m pytest -q` ·
**Status:** 428 tests, all passing (migrations through 0045) — deterministic
(login-throttle state leak fixed). CI runs the suite against a Postgres 16
service on every push/PR and gates the Docker image build on it
(`.github/workflows/docker.yml`).

Recent additions (2026-06-09 → 06-10): `test_zz_players_paging` /
`test_zz_officials_paging` (server q/limit/offset + X-Total-Count),
`test_zz_ical` (RFC 5545 schedule export), `test_zz_db_errors` (global
constraint-violation → 409/400 mapping), and `test_zz_assignment_calc`
(16 pure unit tests pinning the pay/mileage formula and flag semantics —
the first no-DB unit layer over the money path).

Newer additions (2026-06-10 → 06-12): `test_zz_contracts` (response shapes +
query-count ceilings, P2 #14), `test_zz_bulk_savepoint` (per-row savepoint
isolation, the silent-data-loss fix), `test_zz_rate_fallback` (`_rate_for`
earliest-rate fallback), `test_zz_day_of` (per-day actual status + player
check-in, migration 0040), `test_zz_incidents` (incident log, 0043),
`test_zz_assignment_audit` (assignment change audit, 0044),
`test_zz_doubles_partner` (doubles partner + pairing-avoidance group
detection, 0041/0042), `test_zz_email_extract` (pure extractor units), and
`test_zz_real_pdf` (real TD email-export fixture). See the
[2026-06-10 → 06-12 additions](#2026-06-10--06-12-additions) section below.

## How the suite is wired

| File | Purpose |
|------|---------|
| `tests/conftest.py` | Sets `PGDATABASE=courtops_test` *before* `app.config` reads env, then runs migrate + seed once per session. All tests run against a sibling DB that never touches the dev/demo `courtops` DB. Also an **autouse `_reset_login_throttle`** fixture that clears `app.routers.auth`'s process-global failed-attempt / lockout dicts before each test — those leaked across tests (the shared test-client IP + tests that POST wrong `admin` passwords could lock the account and 429 a *later* test's autouse login, the old intermittent flake). |
| `tests/test_smoke.py` | Focused tests, one per behavior. Each is small (≤30 lines) and exercises a single API contract or bug-fix. |
| `tests/test_td_e2e.py` | 1 end-to-end test that walks the full TD workflow from Setup catalog to staffing report, in API order. |
| `tests/test_config_guard.py` | PII H1 boot-guard unit tests (no DB). |
| `tests/test_zz_*.py` | Per-feature suites (sorted last to avoid session-login races): `inbox`, `inbox_search`, `conflicts`, `correction`, `retention`, `staff`, `h2_crypto`/`h2_player`, `admin_users`, `accept_decline`, `season_pay`, `money_audit`, `geocode`, `availability_check`, `change_password`, `room_pickup`, `cert_guard`, `chase_pending`, `coverage_gaps`, `site_coverage`, `inbox_usta`, `pdf_autodetect`, `role_coverage`, `inbox_status_counts`, `cert_pool`, `list_origin`, `dashboard`, `promote_alternate`, `player_overview`, `deadlines`, `player_search`, `officials_search`, `bulk_invite`, `alternates`, `coverage_fill`, `roster_csv`, `availability_grid`, `conflict_report`, `roster_completeness`, `digest`, `bulk_classify`, `bulk_triage`, `unmatched`, `pay_statement`, `invite_text`, `pay_statements_batch`, `invite_texts_batch`, `rooming_list`, `schedule`, `declined`, `me_availability`, `dietary`, `readiness`, `workload`, `officials_no_login`, `missing_distances`, `inbox_aging`, `players_paging`, `officials_paging`, `ical`, `db_errors`, `assignment_calc`, `contracts`, `bulk_savepoint`, `rate_fallback`, `day_of`, `incidents`, `assignment_audit`, `doubles_partner`, `email_extract`, `real_pdf`. |

**Frontend unit check (JS):** the one piece of pure frontend logic that's
risky to verify only through the live grid — seeding the roster add-form from an
inbox email — is factored into `frontend/app/roster_prefill.js` and asserted by
`frontend/app/roster_prefill.test.mjs` (run: `node frontend/app/roster_prefill.test.mjs`,
12 checks). Covers the off-roster→pick-mode and unmatched→new-mode plans plus the
"can't add" gates, independent of Tabulator rendering.

**Test client:** every test module instantiates a FastAPI `TestClient` and
logs in as `admin/admin` at start (lazy login inside the function for the
E2E module — the auth router rotates sessions on every login per audit C3,
so module-load logins would invalidate sibling modules' sessions).

**Test types in use:**

| Type | Definition | Where used |
|------|------------|------------|
| **API integration** | Black-box HTTP call → assert status + body + DB-visible side-effects. | The vast majority of tests. The suite mostly stays at the HTTP boundary; the deliberate exceptions are the pure-unit modules (`test_zz_assignment_calc`, `test_zz_email_extract`, `test_config_guard`) and a handful of internal-helper tests (`test_zz_bulk_savepoint`, `test_zz_rate_fallback`, `test_zz_real_pdf`'s importer calls). |
| **Unit (no HTTP)** | Imports a pure function and pins its contract directly — no DB or test client needed (or a rolled-back transaction where a cursor is required). | `test_zz_assignment_calc` (pay/mileage formula), `test_zz_email_extract` (extractor regexes), `test_config_guard`, `test_zz_rate_fallback`, `test_zz_bulk_savepoint`. |
| **Smoke** | Confirms a feature exists and returns 200/201 with a plausible shape. | `test_health_ok`, `test_site_crud`, etc. |
| **Contract** | Asserts the exact shape, status code, and side-effects a router promises. | `test_player_put_optimistic_concurrency`, `test_assignment_pay_and_mileage`. |
| **Regression** | Reproduces a closed bug + asserts the fix holds. | `test_player_hotels_analytics_and_tshirts` (audit F1), `test_import_doubles_new_player_with_gender` (sixth-pass), `test_roster_import_requires_gender_for_new_players` (audit C1). |
| **End-to-end (E2E)** | Multi-step happy-path through the full TD workflow. | `test_td_full_workflow`. |

---

## test_smoke.py — feature-by-feature contracts

### Catalog CRUD (durable Setup data)

| Test | Type | API surface | Simulates |
|------|------|-------------|-----------|
| `test_health_ok` | Smoke | `GET /api/health` | App + DB are reachable. |
| `test_site_crud` | Smoke | `POST/PUT/DELETE/GET /api/sites` | TD adds a venue, edits its address, removes it. |
| `test_tournament_crud_and_dates` | Contract | `POST /api/tournaments` | TD creates a tournament; bad date order is rejected at model layer (422). |
| `test_tournament_sites_m2m` | Contract | `PUT /api/tournaments/{id}/sites` | TD attaches multiple sites to one tournament; replacing the set drops missing ids; unknown id → 400. |
| `test_official_and_player_crud` | Smoke | `POST/PUT/DELETE/GET /api/officials`, `/api/players` | TD adds officials + players to the Setup catalogs; duplicate USTA # → 409. |
| `test_rate_crud` | Smoke | `POST/PUT/DELETE /api/rates` | TD enters a per-day rate for a certification with an effective date. |
| `test_hotel_and_room_block` | Contract | `POST/PUT/DELETE /api/hotels`, `/api/room-blocks` | TD adds a hotel + a room block; bad check-in/check-out order → 422; bad hotel_id → 400. |
| `test_room_block_kind_filter` | Contract | `GET /api/room-blocks?kind=…` | The Assignments dropdown filters for `kind=official` (comp rooms only). |
| `test_distance_crud` | Contract | `POST/PUT/DELETE /api/distances` | TD records an official↔site mileage; duplicate pair → 409. |
| `test_divisions_events_catalog` | Smoke | `GET/POST/PUT/DELETE /api/divisions`, `/api/events` | TD edits the division/event catalogs (migration 0027). Seed populates 26 + 7. |
| `test_player_gender_required_and_constraint` | Contract | `POST/PUT /api/players` | `gender` is required (Literal + NOT NULL); accepts only `male`/`female`; missing gender → 422, bad value → 422. |
| `test_player_city_state` | Smoke | `POST/PUT /api/players` | Migration 0019: `city` + `state` round-trip. |
| `test_player_history_capture` | Contract | `PUT /api/players/{id}` then `GET .../history` | SCD-Type-4 trigger writes a `player_history` row on every PUT; delete keeps the audit row. |
| `test_player_put_optimistic_concurrency` | Contract / regression (audit M19) | `PUT /api/players/{id}` with `X-If-Updated-At` | Stale timestamp → 409; matching timestamp → 200; subsequent stale → 409. |

### Roster + per-tournament workflow

| Test | Type | API surface | Simulates |
|------|------|-------------|-----------|
| `test_roster` | Contract | `POST /api/tournaments/{id}/players` | TD adds existing players to the roster with division + status; alternate flag round-trips. |
| `test_roster_inline_create_player` | Contract | `POST /api/tournaments/{id}/players` (walk-in path) | TD adds a walk-in by USTA # alone — backend upserts player with the supplied gender so the division picker shows the right list. |
| `test_roster_point_in_time_name` | Contract | `GET /api/tournaments/{id}/players` | Names are resolved at the tournament's `play_start_date`: a rename after the tournament doesn't retroactively change the roster's displayed name. |
| `test_roster_csv_import` | Contract | `POST /api/tournaments/{id}/players/import` | Direct-merge CSV upload: 2 valid rows; re-import is an upsert (no duplicates, name updates apply). |
| `test_roster_import_requires_gender_for_new_players` | Regression (audit C1) | Direct-merge import | New-player row without gender → row-level error; existing-player row without gender → upserts fine. |
| `test_roster_import_normalizes_tshirt_sizes` | Contract | Direct-merge import | Free-text sizes (`YM`, `Adult Large`, `xl`, `youth small`, `AS`) all normalize to canonical (`Youth Medium`, `Adult Large`, `Adult Extra Large`, `Youth Small`, `Adult Small`). |
| `test_summaries_exclude_withdrawn_and_alternates` | Contract | Per-tournament hotel/lodging summaries | Withdrawn + alternate players don't appear in the per-tournament summary counts (only `selection_status='selected'`). |

### Assignments + pay snapshots

| Test | Type | API surface | Simulates |
|------|------|-------------|-----------|
| `test_assignment_pay_and_mileage` | Contract | `POST /api/tournaments/{id}/assignments`, `POST /api/assignments/{id}/days` | TD assigns an official + adds 3 working days at a cert; pay = days × rate; mileage snapshot fires; missing_distance flag clears when a distance row exists. |
| `test_assignment_missing_distance_and_hotel_mismatch` | Contract | Assignments | Without a distance row, `missing_distance=true` + report flag. Hotel dates outside the tournament window flag `hotel_date_mismatch`. |
| `test_work_date_out_of_window_flag` | Contract | Assignments | A `work_date` outside `play_start_date..play_end_date` flags `work_date_out_of_window` on the report. |
| `test_pay_snapshot_persisted` | Regression (audit §5.3) | Assignments | The pay + mileage snapshot is *written* to the day row, not re-computed each read — protects historical money trail from rate edits. |
| `test_room_count_enforced` | Contract | `POST /api/assignments` with `room_block_id` | If a block's `rooms_remaining=0`, the assignment is rejected (409). |
| `test_room_block_create_returns_rooms_remaining` | Smoke | `POST /api/room-blocks` | The create response includes the computed `rooms_remaining` (not just `room_count`). |

### Part B intake (email-filed lists)

| Test | Type | API surface | Simulates |
|------|------|-------------|-----------|
| `test_triage_suggest` | Contract | `POST /api/emails/{id}/suggest` | The local rule-based triage classifies subject + body into one of 9 buckets (no LLM, no data leaves the building). |
| `test_inbox_and_late_entry_filing` | Contract | `/api/emails`, `/api/tournaments/{id}/late-entries` | An email is staged; filing it as a late entry marks the email `filed`/`late_entry` AND adds the player to the roster (source=late_entry). |
| `test_late_entry_past_deadline_flag` | Contract | Late entries | A request_date after `tournament.late_entry_deadline` flags `past_deadline=true` on the row. |
| `test_withdrawal_reason_rule_and_roster_flip` | Contract | `/api/tournaments/{id}/withdrawals` | A withdrawal needs a reason UNLESS the player was an alternate. Filing flips the roster row to `selection_status='withdrawn'`. |
| `test_withdrawal_alternate_needs_no_reason` | Contract | Withdrawals | Same path with `was_alternate=true` → reason becomes optional. |
| `test_withdrawal_update_keeps_reason_rule` | Contract | PUT withdrawal | Editing a withdrawal that's NOT for an alternate still requires a reason (rule applies to update, not just create). |
| `test_part_b_inline_edits` | Contract | PUT on every Part-B list | In-grid cell edits hit the right endpoint and update only the editable fields. |
| `test_pairing_and_doubles_update` | Contract | PUT pairing-avoidance + PUT doubles-pair | Editable fields (division, relationship) round-trip; protected fields stay put. |

### Doubles + pairing

| Test | Type | API surface | Simulates |
|------|------|-------------|-----------|
| `test_doubles_mutual_verification` | Contract | `POST /api/tournaments/{id}/doubles-requests` | Two players each name the other as partner; the second filing automatically pairs them (`verified=true`). |
| `test_doubles_random_queue` | Contract | Random doubles | FIFO queue per (tournament, division): the longest-waiting random request pairs with the next random in the same division. |
| `test_doubles_random_requires_division` | Contract / validation | Random doubles | A random request without an age_division → 400 (random pairing needs the division). |
| `test_pairing_avoidance_group` | Contract | `POST /api/tournaments/{id}/pairing-avoidances` | A 2+ member group (siblings or same-club) is inserted atomically; member list round-trips. |

### Hotels + t-shirts

| Test | Type | API surface | Simulates |
|------|------|-------------|-----------|
| `test_player_hotel_fk_dedup` | Contract | `/api/tournaments/{id}/player-hotels` | Hotel names with case/spacing differences upsert to the same canonical Hotel row (migration 0023 FK). |
| `test_hotel_confidential_report` | Contract | `/api/tournaments/{id}/hotel-confidential-report` | The print report returns a summary pivot + initials-only player detail (minors' PII protection, audit §5). |
| `test_player_hotels_analytics_and_tshirts` | Regression (audit F1) | `/api/hotel-analytics` | The CVB analytics endpoint counts per-`(player, tournament)` stay, not distinct player — fixes the CVB-negotiation number. |
| `test_tshirt_order_lifecycle` | Contract | `/api/tournaments/{id}/tshirt-order` | TD enters on-hand counts, places the order (snapshot fires), then later withdrawals shift `requested` while `snapshot` stays. Cancel-order clears snapshot. |

### Staged importer (CSV/XLSX upload pipeline)

| Test | Type | API surface | Simulates |
|------|------|-------------|-----------|
| `test_import_staging_and_merge` | Contract | `/api/import/tournaments/{id}/roster`, `.../batches/{id}/merge` | Upload → staged (valid/invalid counts surface) → merge (only valid rows write); re-merge reports conflicts. Asserts CSV + XLSX templates download cleanly AND that template headers match each registered type's column declarations. |
| `test_import_merge_per_type_smoke` | Contract / regression (audit #4) | All 9 importer types | Parametrized: synthesizes a one-row CSV per type and verifies stage + merge succeed with no failures. Catches future merge fns that disagree with their own template. |
| `test_import_doubles_new_player_with_gender` | Regression (sixth-pass) | Doubles importer | A doubles row with a never-seen `usta_number` plus `gender` column passes staging AND creates the player at merge time (regression: `_merge_doubles` had dropped the gender arg into `upsert_player`). |
| `test_import_distances_setup_catalog` | Contract | Distances importer (audit #7) | Setup-catalog importer: row 1 resolves official by `(last_name, first_name)` + site by `site_code`; row 2 by ids overwrites the same `(official, site)` pair with a conflict note. |

### Auth + security

| Test | Type | API surface | Simulates |
|------|------|-------------|-----------|
| `test_auth_gating_and_official_self_service` | Contract | `/api/auth/*`, `/api/me/*` | Unauthenticated → 401. Admin → 200. Official user → 200 on `/me` paths, 403 on admin paths. |
| `test_account_reset_invalidates_sessions` | Regression / contract (audit C3) | `/api/officials/{id}/account` | Resetting an account password drops all the user's existing sessions. |
| `test_certifications_and_role_guard` | Contract | `/api/officials/{id}/certifications` | Admin can add/remove certs; official user gets 403. |
| `test_availability_set_and_list` | Contract | `/api/tournaments/{id}/availability` | TD sets per-official dates; subsequent GET returns the same set. |
| `test_officials_report_totals` | Contract | `/api/tournaments/{id}/reports/officials` | Staffing-plan report includes per-official pay, mileage, total + overall totals. |
| `test_scheduling_and_division_lists` | Smoke | adult lists | Scheduling avoidance + division flex CRUD round-trips. |

---

## test_td_e2e.py — single end-to-end walkthrough

### `test_td_full_workflow` — the only test in the file

A single function that walks the API in the same order a TD does in the UI.
13 logical phases:

| # | Phase | API surface exercised | What it proves |
|---|-------|----------------------|----------------|
| 1 | **Setup catalogs** | sites, hotels, rates, officials, certifications, distances, players | Durable master data round-trips and feeds the rest of the workflow. |
| 2 | **Tournament create + attach sites** | tournaments, `PUT /api/tournaments/{id}/sites` | Bad date order rejected (422); site M2M works. |
| 3 | **Roster** | `POST /api/tournaments/{id}/players` × 3 modes | (a) link existing player_id; (b) USTA-by-id with status=alternate; (c) walk-in inline-create with USTA + gender + first/last. Shirt size normalizes. |
| 4 | **Availability** | `PUT /api/tournaments/{id}/availability` | Per-official date sets — one official full-window, one partial. |
| 5 | **Room blocks** | `POST /api/room-blocks` (`kind=official`) | Officials-comp block reserved with check-in/out + room_count. |
| 6 | **Assignments** | `POST /api/tournaments/{id}/assignments`, `POST .../days` × 3 | Pay snapshot per day via `rate_applied`; mileage snapshot fires; `missing_distance=false`; hotel attaches; `rooms_remaining` decrements. |
| 7 | **Part B intake** | `POST /api/emails`, `POST .../suggest`, file as late entry + withdrawal | Heuristic triage classifies. Filing late entry adds player to roster + marks email filed. Withdrawal requires reason (missing → 400); successful filing flips roster status to `withdrawn`. |
| 8 | **Preferences** | scheduling, division-flex, pairing-avoidance group, doubles mutual | Mutual doubles pair when both sides file. Pairing-avoidance validates ≥2 distinct members. |
| 9 | **Player hotels** | player-hotels, hotel-summary, lodging-summary, hotel-analytics | Per-tournament summaries + cross-tournament CVB analytics pick up the stay. |
| 10 | **T-shirt order** | `GET/POST /api/tournaments/{id}/tshirt-order` | Snapshot today's requested counts. |
| 11 | **Reports** | `GET /api/tournaments/{id}/reports/officials` | Staffing plan with day grid + per-official totals + hotel attribution. |
| 12 | **Optimistic concurrency** | `PUT /api/players/{id}` with `X-If-Updated-At` | Stale timestamp → 409 even after a successful prior write with the same (now-stale) timestamp. |
| 13 | **Read-back smoke** | `GET` on all 15 workspace endpoints | No model drift between what was written and what serializes back. |

**Why one big test instead of 13 small ones?** This is the workflow's
*ordering* contract — each phase relies on artifacts from the prior
phases. A breakage in phase 6 (assignments) could be caused by phase 3
(roster) or phase 4 (availability), and we want a single failure to
surface the chain. The `test_smoke.py` tests cover each contract in
isolation; this one proves they compose.

---

## What's NOT covered

| Surface | Coverage status | Why |
|---------|----------------|-----|
| Frontend JavaScript (`app.js`, `app/grids.js`, `util.js`, `shirts.js`) | **None at runtime** (except `roster_prefill.test.mjs`, above). | No headless-browser test harness. Manual + preview-driven QA covers UI; backend tests cover all API contracts the UI calls. |
| Print stylesheet | **Visual / manual.** | Print fidelity validated in the preview during the Reports + Confidential-hotel-report polish passes. |
| Browser-side ARIA tab semantics + focus-trap | **Manual.** | Verified via DevTools + screen reader during the eighth audit pass. |
| Cookie / CSRF flow | **Partial.** | Auth gating + session rotation covered (`test_auth_gating_and_official_self_service`, `test_account_reset_invalidates_sessions`). CSRF deferred per the original audit. |
| Migration *upgrade* sequence on a non-empty DB | **None.** | `conftest.py` migrates a fresh DB before each session. No tests run migrate forward across a populated database. |
| Concurrency / load | **None.** | Single-user POC. |

## Running

```bash
cd backend
source .venv/Scripts/activate                          # Windows: .venv\Scripts\activate
python -m pytest -q                                    # the whole suite (428)
python -m pytest tests/test_td_e2e.py -v               # just the end-to-end walk
python -m pytest -k "import" -v                        # just the importer tests
python -m pytest tests/test_smoke.py::test_player_put_optimistic_concurrency -v
```

The first run is slowest (~60s) because `conftest.py` migrates + seeds a
fresh `courtops_test` DB. Subsequent runs reuse it.

## How to add a test

Patterns in this suite:

1. **Use the `_ok(r, code=201)` helper** — every POST in the codebase
   returns 201, every PUT returns 200, every DELETE returns 204. The
   helper asserts the status and returns the JSON body in one call.
2. **Use the fixture helpers** (`_site`, `_tournament`, `_official`,
   `_player`, `_hotel`) — they generate uuid-tagged names so tests
   don't collide across runs.
3. **Stay at the HTTP boundary** — no internal-module imports. If you
   need to seed something the API can't yet, prefer adding the missing
   API endpoint over a DB-side back door.
4. **One concept per test** — `test_smoke.py` keeps tests small;
   `test_td_e2e.py` is the only multi-concept test by design.
5. **Tag the audit reference** in the docstring when a test exists
   specifically to lock in a bug fix (audit C1, F1, sixth-pass, etc.).

---

## Backlog B1/B2/B3 tests (added 2026-05-28)

Eight new tests in `test_smoke.py` cover the schema additions in migrations
0028 + 0029 and the three new importers.

| Test | What it locks in | Type |
|------|------------------|------|
| `test_b1_division_site_assignment_and_tshirt_report` | End-to-end: link sites → assign 3 divisions → roster players → `/tshirts-by-site` buckets by site_name; "Unassigned" pile; 1-to-1 invariant on re-PUT; 400 when assigning to a site not linked to the tournament; `site_id=null` clears | E2E API |
| `test_roster_initial_import_full_player_data` | B2a: CSV stage → merge → player catalog WTN/section/district populated; year-of-birth → 2012-01-01 with precision=year; roster carries division/events split + payment snapshot; re-import overwrites with conflict note | E2E |
| `test_roster_initial_selection_precedence` | "SELECTED, PRE_SELECTED" → 'selected'; "WITHDRAWN, ALTERNATE" → 'withdrawn'; defaults | Unit |
| `test_roster_initial_event_parse` | Both word orders: "Boys' Singles 14 & under" AND "Girls' 14 & under singles" parse to (B14, Singles) etc.; bare canonical names pass through | Unit |
| `test_roster_correction_draw_status_precedence` | "Withdrawn, Alternate" → withdrawn; "Main draw" → selected; blanks → None | Unit |
| `test_roster_correction_import_updates_existing_and_late_adds` | Existing row: status flipped + sign-in flag, t-shirt preserved; new USTA → late-add with parsed status; rows NOT in the file stay untouched across re-runs | E2E |
| `test_b3_hotel_answer_parse` | "No, I am local" → "Local / family"; "Yes, I plan to reserve…" → "Hotel"; Commuter variants; unmappable → raw fallback; blanks | Unit |
| `test_b3_combined_tshirt_hotel_dietary_import` | Late-add new player to roster (full row); existing player with only the hotel column → t-shirt + dietary preserved (blanks don't overwrite); hotel mapping lands | E2E |
| `test_b3_unmappable_hotel_answer_stored_raw` | Free-text answer that doesn't match the mapping table → preserved verbatim in `lodging_plan_raw` | E2E |

**Live verification with real USTA exports** (one-shot, not part of the
suite): the three production files from June 2026 merged cleanly —
B2a 184 rows / 0 failures; B2b 199 rows / 0 failures (50 conflicts =
players already in roster from Initial); B3 184 rows / 0 failures.
Distribution after all three: 147 Hotel / 27 Local / 25 None lodging;
127 selected / 54 alternate / 18 withdrawn statuses.

---

## 2026-06-10 → 06-12 additions

### test_zz_contracts.py — API contract tests (P2 #14) · 6 tests

Two hardening layers over endpoints that return hand-built dicts (no
`response_model`, so FastAPI can't validate them).

| Test | Type | What it locks in |
|------|------|------------------|
| `test_assignment_summary_shape` | Contract | Assignments list: money fields are real numbers (never Decimal-as-string), flags are real booleans, day dates are ISO strings, list fields present even when empty, `response_status` enum. |
| `test_pay_statement_shape` | Contract | Pay-statements report: per-official `pay`/`mileage`/`total` + `totals` are numeric. |
| `test_officials_report_shape` | Contract | Staffing report: officials list + numeric totals + per-official `days` list. |
| `test_assignments_list_query_ceiling` | Contract (perf) | Counting cursor via monkeypatched `get_conn`: the assignments list stays ≤24 queries for 3 staffed assignments — trips if a per-day query sneaks into `_summary`. |
| `test_players_list_query_ceiling` | Contract (perf) | `paged_select` = COUNT + SELECT (+ auth) ≤5 queries — trips on any per-row query. |
| `test_emails_list_query_ceiling` | Contract (perf) | Inbox list ≤6 queries (the lazy USTA backfill adds at most one UPDATE per legacy row; the test inbox has none). |

### test_zz_bulk_savepoint.py — per-row savepoint isolation (P2 #10) · 2 tests

| Test | Type | What it locks in |
|------|------|------------------|
| `test_without_savepoint_one_error_poisons_the_transaction` | Unit (DB cursor) | Documents the Postgres failure mode the helper exists for: after one failed statement the whole transaction is aborted — the naive catch-and-continue pattern raises `InFailedSqlTransaction` on the next row and the request-end COMMIT silently rolls everything back. |
| `test_savepoint_isolates_the_failed_row_and_the_rest_commits` | Unit (DB cursor) | `app.bulk_ops.savepoint` skips only the duplicate row; the survivors really persist after COMMIT (the silent-data-loss fix). |

### test_zz_rate_fallback.py — `_rate_for` fallback semantics · 1 test

| Test | Type | What it locks in |
|------|------|------------------|
| `test_pre_catalog_work_uses_earliest_rate_and_on_date_uses_effective` | Unit (rolled-back transaction) | Work logged BEFORE the rate catalog starts picks the EARLIEST known rate (nearest that early date), not the newest; work on/after an effective date gets the rate in effect that day. |

### test_zz_day_of.py — day-of operations (P4-1/P4-2, migration 0040) · 4 tests

| Test | Type | What it locks in |
|------|------|------------------|
| `test_no_show_drops_out_of_pay_and_back` | Contract | `PUT /api/assignment-days/{id}/status`: marking a day `no_show` excludes it from pay (snapshot refrozen, `pay_audit` reflects it); flipping back to `worked` restores full pay. |
| `test_day_status_validation_and_404` | Contract | Bad status value → 422; unknown day id → 404. |
| `test_no_show_day_leaves_the_ics_feed` | Contract | A `no_show` day drops its VEVENT from `GET /api/officials/{id}/schedule.ics`. |
| `test_player_check_in_toggle` | Contract | `PUT /api/roster/{id}/signin` toggles `signed_in` both ways; the roster list reflects it; unknown roster id → 404. |

### test_zz_incidents.py — day-of incident log (P4-3, migration 0043) · 3 tests

| Test | Type | What it locks in |
|------|------|------------------|
| `test_log_resolve_and_scope` | Contract | Quick-log defaults (`resolved=false`, `occurred_at` now); per-tournament scoping; resolve with a note; open incidents sort before resolved. |
| `test_validation_and_404s` | Contract | Bad category / empty description → 422; unknown tournament/incident ids → 404 on POST/PUT/DELETE. |
| `test_site_label_and_delete` | Contract | `site_label` resolves to the site code; DELETE → 204 and the list empties. |

### test_zz_assignment_audit.py — assignment change audit (P4-5, migration 0044) · 3 tests

| Test | Type | What it locks in |
|------|------|------------------|
| `test_lifecycle_actions_are_recorded_with_actor` | Contract | created / day_added / day_status / day_removed land in `GET /api/assignments/{id}/audit` (newest first) with `changed_by` + structured `detail`. |
| `test_official_response_is_attributed_to_their_login` | Contract | An official's accept via `/api/me/assignments/{id}/respond` (second TestClient so the login doesn't rotate the admin session) is attributed to their username. |
| `test_trail_survives_assignment_deletion` | Contract | Deleting the assignment NULLs the FK (per-assignment endpoint returns []) but the rows survive with denormalized `official_name`, queryable by tournament. |

### test_zz_doubles_partner.py — doubles partner + pairing groups (migrations 0041/0042) · 16 tests

E2E through the inbox API: a doubles email names TWO players — the detector
fills both slots (primary + partner), the inbox list returns both names, and
re-classifying away from doubles clears the partner.

| Test | Type | What it locks in |
|------|------|------------------|
| `test_doubles_email_detects_both_players` | Contract | `POST /api/emails/{id}/detect-player` on a doubles email fills `detected_player_id` AND `detected_partner_id`/`_name`; the inbox list carries both. |
| `test_non_doubles_email_keeps_partner_null` | Contract | Two names in a non-doubles email → partner stays NULL. |
| `test_single_name_doubles_email_has_no_partner` | Contract | One name → primary only. |
| `test_reclassifying_away_from_doubles_clears_partner` | Contract | PUT to `late_entry` clears the detected partner. |
| `test_bulk_detect_fills_partner` | Contract | `POST /api/emails/bulk/detect-players` fills the partner too. |
| `test_pairing_email_detects_the_whole_group` | Contract | A pairing-avoidance email naming 3 rostered players fills `detected_member_ids`/`_names` (whole group), surfaced in the list. |
| `test_single_name_pairing_email_keeps_members_null` | Contract | One name → no group. |
| `test_reclassifying_away_from_pairing_clears_members` | Contract | PUT to `withdrawal` clears the member group. |
| `test_doubles_pair_matches_by_usta_numbers_alone` | Contract | Both USTA numbers, NO names — the pair resolves entirely via USTA match (`detected_partner_usta` set). |
| `test_doubles_text_keeps_both_numbers_when_unmatched` | Contract | Two unrostered numbers: nobody matches but BOTH surface in `detected_usta_text` (the old single-number extractor gave up). |
| `test_doubles_mixed_one_matched_one_text_only` | Contract | Rostered number matches; the stranger's number still surfaces in the text. |
| `test_first_mentioned_number_is_primary` | Contract | The TD's real `<usta> <name>` format twice over: the FIRST-mentioned pair is the requester — roster iteration order must not decide. |
| `test_manual_partner_assignment_persists` | Contract | Manual Player 2 via `PUT /api/emails/{id}` with `detected_partner_id` persists; list returns partner id + name + USTA. |
| `test_manual_partner_survives_any_classification` | Contract | The TD's manual pick wins even off the doubles classification (e.g. a withdrawal naming two players). |
| `test_clearing_primary_clears_manual_partner` | Contract | Clearing the primary player clears the manual partner too. |
| `test_put_without_partner_field_clears_it` | Contract | A PUT body that omits `detected_partner_id` resets it to NULL, like the other `detected_*` fields. |

### test_zz_email_extract.py — pure extractor units (P2 #9) · 15 tests

UNIT tests for `app/email_extract.py` — no DB, no HTTP. Pins each extractor's
contract directly, including the conservative give-up paths.

| Test | Type | What it locks in |
|------|------|------------------|
| `test_usta_labeled_beats_bare` | Unit | A labeled `USTA #:` number wins over longer bare digit runs (phone numbers). |
| `test_usta_single_bare_run` | Unit | A single bare 10-digit run qualifies. |
| `test_usta_ambiguous_bare_numbers_give_up` | Unit | Two bare numbers → `extract_usta` returns None (conservative). |
| `test_usta_none_when_absent` | Unit | No numbers → None. |
| `test_division_usta_wording_and_code` | Unit | "Boys' 14 & under" → B14; "G 16" → G16. |
| `test_division_only_junior_ladder` | Unit | "B 11" and adult NTRP don't match. |
| `test_events_mixed_not_double_counted` | Unit | "singles and mixed doubles" → both, mixed not double-counted as doubles. |
| `test_reason_field_then_due_to_then_keyword` | Unit | Reason precedence: `Reason:` field → "due to …" clause → keyword (Illness) → None. |
| `test_reason_skips_portal_boilerplate` | Unit | The portal's "for the following reason:" boilerplate with nothing after it → None. |
| `test_avoid_day_abbreviations` | Unit | "Saturday or sun morning" → "Sat, Sun". |
| `test_avoid_time_clause_beats_daypart` | Unit | "not before 10:30 AM mornings" → the clause wins over the daypart. |
| `test_extract_ustas_multiple_numbers` | Unit | Multi-number extraction: labeled + bare in order, deduped; formatted phone numbers excluded; capped at 3 (a wall of digits is noise). |
| `test_usta_number_before_name_pattern` | Unit | Unlabeled 8-digit numbers qualify via name adjacency (`<usta> <name>`); subject + body candidates in order of appearance; a bare 8-digit run with no adjacent name does NOT qualify. |
| `test_name_usta_pairs_real_corpus_shapes` | Unit | `extract_name_usta_pairs` across all 5 real-corpus doubles shapes: bulleted `Name USTA# nnn` lines, `(USTA nnn)` labels, bare parens, prose with sentence-leakage trimming, and number-first. |
| `test_name_first_eight_digit_unlabeled_qualifies` | Unit | `Kate Hampton 20188402` — name BEFORE the number also admits the candidate. |

### test_zz_real_pdf.py — real TD email-export fixture · 3 tests

Parses `backend/tests/fixtures/tournament_emails.pdf` — an actual "Tournament
Emails for CourtOps" export (30 emails, quoted reply chains, glyph-quadrupled
labels) — through `_parse_pdf_emails` → triage → pair detection.

| Test | Type | What it locks in |
|------|------|------------------|
| `test_parses_every_email_with_subject_and_body` | Regression (real data) | All 30 emails parse with a non-empty subject and body; known threads (incl. deglyphed labels) present. |
| `test_real_doubles_email_detects_pair_with_ustas` | E2E (real data) | "Confirmed partnership" (names only, no USTA #s in the text) triages `doubles` and links BOTH rostered players; both USTA numbers surface from their roster records. |
| `test_usta_portal_withdrawal_template_detected` | E2E (real data) | The portal subject template ("WITHDRAWAL REQUEST: <first name>, Boys' 14 & under singles" — no surname) resolves via the L5 layer when exactly one rostered boy fits. |

### Other recent suites (already summarized in the wiring table)

| File | Tests | What it covers |
|------|-------|----------------|
| `test_zz_assignment_calc.py` | 16 | Pure unit tests pinning the pay/mileage formula and flag semantics (no DB). |
| `test_zz_players_paging.py` / `test_zz_officials_paging.py` | 6 / 4 | Server-side q/limit/offset + `X-Total-Count`. |
| `test_zz_ical.py` | 4 | RFC 5545 schedule export. |
| `test_zz_db_errors.py` | 4 | Global constraint-violation → 409/400 mapping. |

---

Total suite count: **428 tests, all passing** (see the status line at the top).
`test_zz_payroll.py` (8) — payroll finalization (P4-4): freeze the computed
summary, double-finalize 409, drift after a post-finalize no-show,
unfinalize-unless-paid, mark-paid lifecycle/defaults, idempotent finalize-all,
audit-trail landing, 404s.
