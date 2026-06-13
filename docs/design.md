# CourtOps Tennis — Design & Architecture

A from-scratch rebuild guide. Read alongside [data-model.md](data-model.md)
(schema), [vision-summary.md](vision-summary.md) (product intent), and
[roadmap.md](roadmap.md) (build order). This doc is the *how it's built* —
structure, patterns, and the domain rules that aren't obvious from the code.

---

## 1. What it is (and isn't)

Back-office tooling for a USTA **Tournament Director (TD)**. Two loosely-coupled
halves that share only `Tournament` and `Player`:

- **Part A — Officials & staffing.** Officials are entered with certifications;
  the TD invites/assigns them per day and per role across venues, tracks
  accept/decline, lodging (hotel room blocks), and computes **pay + mileage**.
  Layered on top: coverage/conflict/readiness reports, exports, dashboards.
- **Part B — Player operations.** A human-reviewed **inbox**: inbound
  parent/player email is triaged (classify → match a roster player → file) into
  structured lists — roster, late entries, withdrawals, scheduling avoidances,
  division flexibility, doubles, pairing avoidances, player hotels, t-shirts.

**Deliberately out of scope:** draw generation, live scoring, money movement.
The tool stops at producing structured, auditable lists + a staffing plan.

**Design philosophy that recurs everywhere:**
- *Manual-first, automate-later* — every integration point (mileage, email, USTA)
  has a manual path that works before the integration exists.
- *Flag, don't block* — data-quality problems (double-booking, uncertified day,
  out-of-window, hotel-date mismatch) are surfaced as warnings, not hard errors;
  the TD decides. Only physical impossibilities (a full room block) hard-block.
- *Provenance on Part B* — every filed row links back to its source email.
- *Minors' PII is a constraint* — names/emails/phones/birthdate encrypted at rest.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| DB | **PostgreSQL 16** (Docker, container `courtops-pg`) | Plain SQL migrations, no ORM. |
| API | **FastAPI + psycopg 3** + **Pydantic** | One connection per request; raw SQL. |
| Frontend | **Vanilla HTML/CSS/JS**, no build step | One big `app.js` (ES module) + 8 small helper modules (`util, shirts, roster_prefill, grids, auth, state, player_list, html`); **Tabulator 6.3.1** vendored for grids. |
| Auth | pbkdf2-sha256 + server-side cookie session | POC: `admin/admin`. |
| Deps | `requirements.txt` | fastapi, uvicorn[standard], psycopg[binary], pydantic, python-dotenv, pytest, httpx, openpyxl (xlsx import), pdfplumber (PDF email import), python-multipart (uploads), cryptography (PII Fernet). |

No framework on the frontend, no ORM on the backend — both deliberate, to keep
the POC legible and dependency-light. Scale notes are in §11.

---

## 3. Repository layout

```
backend/
  app/
    main.py            # FastAPI app: router mounting, auth split, static mount, no-cache mw
    config.py          # env Settings + prod boot-guard (validate())
    db.py              # get_conn() + db_dep() per-request connection
    security.py        # hash_pw/verify_pw, get_current_user, require_admin
    crypto.py          # Fernet encrypt/decrypt for PII-at-rest (H2)
    triage.py          # local keyword email classifier (no LLM)
    email_extract.py   # pure regex extraction from email text: USTA #s, (name, USTA#) pairs,
                       # withdrawal reason, division, events, avoid day/time
    assignment_calc.py # pure pay/mileage/flag math (rates, free band, cap, RULE_VERSION)
    bulk_ops.py        # savepoint() contextmanager: per-row failure isolation in bulk loops
    db_errors.py       # global psycopg unique/FK/check handlers -> friendly 4xx
    query_helpers.py   # like_escape + paged_select (q/limit/offset + X-Total-Count)
    importer.py        # staged spreadsheet import: per-type registry, parse/validate/merge
                       # (+ PDF inbox import: a tournament-emails PDF -> staged email rows)
    email_targets.py   # single source of truth: classification -> target list registry
    playerops.py       # upsert_player, mark_email_filed (shared helpers)
    shirtops.py        # t-shirt size normalization
    geocode.py         # great-circle mileage estimate; also the Google Maps Distance Matrix
                       # driving-distance path when GOOGLE_MAPS_API_KEY is set
                       # (stamps distance_source='maps', else 'geocoded')
    retention.py       # PII retention sweep helpers (H3)
    ical.py            # RFC 5545 builder: an official's schedule as .ics (admin + portal)
    models.py          # re-exports the Pydantic models from the _models_* files
    _models_common.py / _models_auth.py / _models_setup.py /
    _models_workspace.py / _models_inbox.py     # Pydantic models, grouped by area
    routers/           # one module per resource (see §6)
  migrations/          # 0001_*.sql … 0047_*.sql, applied in filename order
  migrate.py           # runner: create DB if needed, apply pending, track in schema_migrations
  seed.py              # lean idempotent baseline (sites, 32 players, rates, admin)
  reset_demo.py        # truncate (preserving migration-seeded catalogs) + seed
  demo_seed.py         # rich, coherent "live event" demo on top of reset_demo
  backfill_distances.py
  tests/               # pytest: test_smoke.py, test_td_e2e.py, test_zz_*.py (per-feature)
frontend/
  index.html           # the single page (all panels, hidden/shown via tabs)
  app.js               # ~7.3k lines: all behaviour (ES module)
  app/util.js, app/shirts.js, app/roster_prefill.js   # extracted pure helpers (+ a .test.mjs)
  app/grids.js         # Tabulator grid factories (createGridFactories(ctx) — P2 #11a)
  app/auth.js          # login + session view (sign-in/out, change-password, role-split header)
  app/state.js         # active-tournament state + change event
  app/player_list.js   # Part B list-page factory (wirePlayerList)
  app/html.js          # auto-escaping html`` / hstr tagged-template helper
  styles.css, tokens.css
  vendor/tabulator.*   # vendored grid lib
scripts/
  e2e_td_scenario.py   # standalone black-box end-to-end driver (external HTTP client)
docs/                  # this file + the others
Dockerfile             # all-in-one POC image (Postgres + API + frontend, demo baked at build)
docker/entrypoint.sh   # boots bundled Postgres, migrates, seeds-if-fresh, ADMIN_PASSWORD, uvicorn
fly.toml / render.yaml / Caddyfile   # hosting configs (see docs/deploy.md)
.github/workflows/docker.yml         # CI: pytest (Postgres service) gates image build;
                                     # pushes ghcr.io/<owner>/tennis-app:latest on main
```

---

## 4. Backend wiring (`main.py`)

- `FastAPI(title=..., version=...)`. On import, `settings.validate()` runs the
  **boot guard** (refuses to start a non-dev deployment that still has default
  superuser creds / no TLS / the dev encryption key).
- **Three open routers** (no auth dep): `health`, `auth` (login), `me` (official
  self-service — it checks the session itself via `get_current_user`).
- **Everything else is admin-only**, mounted in a loop with
  `dependencies=[Depends(require_admin)]`. This is the key security choke point:
  a new TD/back-office router is admin-gated simply by adding it to that tuple.
- A `@app.middleware("http")` sets `Cache-Control: no-store` on **non-`/api`**
  responses (the frontend), so the dev edit loop isn't defeated by Chromium's
  aggressive ES-module caching. (Production: hashed filenames instead.)
- `StaticFiles(directory=frontend, html=True)` mounted at `/` serves the SPA.

The API lives under `/api/...`; the frontend at `/`.

---

## 5. Cross-cutting backend patterns

**Per-request DB connection (`db.py`).** `db_dep()` is a FastAPI dependency that
opens a fresh `psycopg` connection (dict rows), `yield`s it, **commits on
success / rolls back on exception**, and closes it. No pool — one connection per
request, always committed before the response returns (so no read-after-write
surprises across requests). Routers do `conn=Depends(db_dep)` then
`with conn.cursor() as cur: cur.execute(...)`.

**Raw parameterised SQL.** No ORM. Every value is a bound parameter (`%s` /
`%(name)s`) — never string-interpolated. Static SQL fragments (column lists,
`WHERE`/`LIMIT` builders) may be concatenated, but never user values.

**Pydantic models, grouped.** Request/response shapes live in `_models_*.py` by
area (`_models_auth`, `_models_setup`, `_models_workspace`, `_models_inbox`,
`_models_common`) and are re-exported from `models.py` so routers import from one
place. Models do light validation (required fields, enums, ranges).

**Errors are `HTTPException`.** 404 for missing, 400 for bad input, 409 for
unique/business conflicts, 403/401 for auth. Conflict and FK violations from
psycopg are caught and re-raised as friendly 4xx — globally, via the exception
handlers `db_errors.install(app)` registers (unique → 409, FK → 400/409,
check → 400, each naming the violated constraint), so routers don't need
per-call try/except.

**Bulk loops use savepoints (`bulk_ops.savepoint`).** In Postgres the *first*
failed statement aborts the whole transaction: every later statement raises
`InFailedSqlTransaction` and the request-end commit silently becomes a rollback
— so a bulk loop that catches an error and "continues" loses **all** its rows
while still reporting success counts. The fix is a shared `savepoint(cur)`
contextmanager: each per-row write runs inside `with savepoint(cur):`, a
failure rolls back only that row, and the loop records it in `skipped` and
carries on.

**Server-side search/paging (`query_helpers`).** The big lists share
`paged_select` (builds `q`/`limit`/`offset` SQL + sets the `X-Total-Count`
header) and `like_escape` (escapes `%`/`_` in user search terms).

**Route ordering rule.** Static path segments must be declared **before** dynamic
`/{id}` routes in the same router, or they're swallowed as the id (e.g.
`/api/officials/search` and `/workload` are declared above `/{official_id}`).
Cross-router static-vs-dynamic collisions are avoided by full-path naming.

**Migrations are forward-only, filename-ordered** (`0001…0044`), each tracked in
`schema_migrations`. `migrate.py` creates the DB if absent then applies pending
files. **Reference catalogs** (`division`, `tournament_event`,
`certification_rate`) are seeded *by migrations*, so `reset_demo.py` preserves
those tables on wipe (truncating them would leave the pickers empty).

---

## 6. The routers (resource map)

One module per resource under `app/routers/`. Setup/catalog vs per-tournament
workspace vs Part B vs reporting:

- **Auth/session:** `auth` (login/logout/change-password, login throttle),
  `users` (admin user management), `me` (official self-service: my assignments,
  my availability, my pay, my schedule as an `.ics` download).
- **Setup catalog:** `sites`, `hotels`, `room_blocks`, `rates` (certification
  rates), `divisions` (+ events catalog), `certifications` (per-official),
  `distances` (official↔site mileage, manual + `geocode` auto), `tournaments`,
  `players`, `staff` (non-official tournament staff).
- **Tournament workspace:** `roster` (entries + CSV import + alternates +
  completeness), `assignments` (the big one — per-day roles, pay/mileage
  snapshots, conflicts, bulk-invite, coverage candidates/fill, invite text, pay
  statements), `availability` (TD-entered + the heatmap grid), `dashboard`
  (per-tournament + cross-tournament digest/deadlines + readiness), `reports`
  (staffing plan, coverage, schedule, rooming list, dietary, missing-distance,
  officials-without-login), `incidents` (day-of incident log: weather, injury,
  dispute, facility, conduct — logged as one-liners, optionally resolved later),
  `payroll` (payroll finalization + mark-paid + CSV export; freezes computed pay
  into an immutable `payroll_record`, migration 0045).
- **Part B inbox:** `emails` (the review inbox: list/search/status, triage =
  classify→detect→populate, aging, unmatched), and the per-classification list
  routers `late_entries`, `withdrawals`, `doubles`, `pairing_avoidances`,
  `player_hotels`, `adult_lists` (scheduling avoidance + division flex),
  `imports` (staged spreadsheet import for every type).
- **Other:** `health`, `retention` (PII purge sweep), `trash` (Trash list +
  restore for soft-deleted tournaments + incidents; migration 0046).

**Shared domain helpers** (not routers): `playerops.upsert_player` (the single
player-identity path, keyed by USTA #), `playerops.mark_email_filed`,
`email_targets` (the classification→target-list registry used by both single-file
and bulk populate so they can't drift), `shirtops.norm_shirt`, `crypto`,
`triage.classify`, `email_extract` (pure regex extraction from email text),
`assignment_calc` (pure pay/mileage math), `bulk_ops.savepoint`, `db_errors`,
`query_helpers`, `ical`, `importer`.

---

## 7. Key domain rules (the non-obvious logic)

**Pay & mileage (`assignments.py`).** An assignment has per-day rows
(`assignment_day`), each with a `working_as` role and a snapshotted
`rate_applied` (the certification rate in effect that day). Then:
- `pay = Σ rate_applied over worked days`
- `mileage = clamp((2·one_way_miles − FREE_MILES) · MILEAGE_RATE, 0, MILEAGE_CAP)`
  with `FREE_MILES=50`, `MILEAGE_RATE=0.65`, `MILEAGE_CAP=100.0`. So the first 50
  *round-trip* miles are free → any one-way ≤ 25 mi yields **$0** even with a
  distance on file (the UI shows a "free band" hint to avoid looking broken).
- `total = pay + mileage`. On every change the figures + the calc inputs are
  **frozen** into `pay_audit` (jsonb) with a `rule_version`, so a reimbursement is
  reproducible even if rates/distances change later.

**Certification guard (flag, not block).** Adding a worked day whose role the
official isn't certified for is *allowed* but flagged (manual/edit/legacy rows
can carry it); the assign-time picker filters to held certs. An official with **no
certs on file** is allowed any role (data may be incomplete) — but the conflict
report then flags every such day as uncertified.

**Conflict detection.** Within one tournament an official has a single assignment
with one role per date (`UNIQUE(assignment_id, work_date)`), so a same-day clash
is necessarily **cross-tournament**. A different venue the same day is a *hard*
conflict (physically impossible); same/no venue is *soft*. `hard_conflict_counts`
is a cheap set-based count (double-bookings + uncertified) used by the dashboard;
the full categorised report adds out-of-window / outside-availability / hotel
mismatches.

**Readiness scorecard** rolls these into pass/warn/fail per area; `fail` =
blocker (uncovered day, double-booking, declined slot), `warn` = should-resolve.

**Division logic.** Junior division = gender prefix (B/G) + age bucket
(12/14/16/18, rounded up) from birth year. The catalog (`division`,
`tournament_event`) is editable Setup data, seeded by migration 0027.

**Email triage (`triage.py` + `email_extract.py`).** Purely **local keyword
rules** (no LLM — minors' PII constraint): ordered patterns map an email's
subject+body to a classification (withdrawal, late_entry, doubles,
pairing_avoidance, scheduling_avoidance, division_flex, hotel, else `other`).
The text-extraction regexes live in `email_extract.py`: **layered USTA-number
patterns** — labeled (`USTA # 1234…`), bare 9–11 digit, number-before-name, and
name-before-number — behind `extract_usta` / `extract_ustas` /
`usta_candidates` / `extract_name_usta_pairs` (the last returns **(name,
USTA #) pairs**, every doubles shape in the real corpus), plus withdrawal
reason, age division, events, and avoid-day/time extractors.

**Player detection (`_detect_player_for`)** is an eight-layer ladder, most to
least reliable; the first layer that yields **exactly one** roster player wins,
and an ambiguous signal is skipped, not guessed: L1 explicit USTA # → L2 full
name in the subject → L3 USTA withdrawal body template → L4 full name in the
body → L5 USTA portal subject template (first name + gender + division) → L6
unique surname in the subject → L7 unique surname anywhere → L8 **off-roster**
USTA match (the # belongs to a player in the system but not entered in this
tournament). `_detect_pair_for` extends it to multi-player classifications:
**doubles** re-runs the ladder with the primary excluded to find the partner;
**pairing_avoidance** loops the ladder, excluding everyone found so far, until
it comes up dry (capped at 6) to find the whole group
(`detected_member_ids`, primary first). Extracted (name, USTA #) pairs feed the
inbox grid for players not yet rostered. Bulk **triage** = classify → detect →
populate in one pass, reusing the three bulk handlers so it can't drift. A
**PDF inbox import** (`emails_pdf` import type, pdfplumber) parses a
tournament-emails PDF into staged email rows.

**Point-in-time names.** Player names are versioned (`player_history`); the roster
resolves the name valid as of the tournament's play-start date.

**Payroll finalization (`payroll.py`, migration 0045).** At event close the TD
**freezes** each official's computed pay into an immutable `payroll_record` so the
figure can't drift when rates/distances change afterward; records can be
**marked paid** (settlement) and unfinalized/unpaid to correct. Finalize-all is
idempotent and detects drift against the live calc. The assignment-change
audit-action enum gains `finalized` / `unfinalized` / `paid` / `unpaid`.

**Soft-delete (`trash.py`, migration 0046).** `tournament` and
`tournament_incident` carry a `deleted_at` column (NULL = active); list queries
filter `deleted_at IS NULL` (partial indexes back the common path), and the Trash
view restores a soft-deleted row. This is **deliberately scoped to tournaments +
incidents only** — players, officials, and emails are *not* soft-deleted: minors'
PII is hard-erased on delete (COPPA), so a recoverable trash there would defeat
the erasure guarantee.

---

## 8. Frontend design

**No build, one page, one big module.** `index.html` contains every panel
(hidden/shown by a two-level menu: L1 groups → tabs). `app.js` (~7.3k lines,
loaded as `<script type="module">`) holds all behaviour; eight ESM helpers under
`app/` split out logic (`util.js` formatting/CSV, `shirts.js` size
normalisation, `roster_prefill.js`, `grids.js` — see below — plus `auth.js`
login/session view, `state.js` active-tournament state, `player_list.js` the
Part B list-page factory, and `html.js` the auto-escaping `html``/`hstr` helper).
Tabulator is vendored.

**Grid factories live in `app/grids.js`** (P2 #11a):
`createGridFactories(ctx)` returns `{ wireEntity, makeListGrid, makeReadGrid,
_autoHeaderFilters }` — the Setup master/detail CRUD factory, the workspace
list grid, the read-only summary grid, and the auto header-filter helper.
`app.js` calls it **once**, passing a `ctx` object of its own helpers (`api`,
`esc`, `setMsg`, `confirmDialog`, the `GRIDS` registry, …) — the factories are
deliberately coupled to the app's toast/message/modal conventions, so only the
construction seam is new; the moved bodies are unchanged. `makeReadGrid`
supports opt-in in-grid editing via `opts.editable` (the `editTriggerEvent`,
e.g. `"dblclick"` so single-click links keep working in editable cells) +
`opts.onCellEdited`. `wirePlayerList` (the Part B list-page factory) has moved to
`app/player_list.js`.

**Structure (rough sections, headers in the file):** theme + small helpers →
keyboard shortcuts → searchable comboboxes → caches/labels/tabs/menu → active-
tournament state → **GRIDS registry + grid factories** (constructed from
`app/grids.js`; `wirePlayerList` from `app/player_list.js`) → workspace pages → Setup entity
configs → CSV/print exporters → Player/Official 360 → dashboards.

**Conventions:**
- `api(path, opts)` wrapper — prefixes `/api`, sends cookies, runs a progress
  bar, humanises 422 detail arrays, raises on non-2xx.
- The `html``/`hstr` tagged-template helper (`app/html.js`) is the **preferred
  auto-escaping path** for building markup — interpolations are HTML-escaped by
  default — over hand-calling `esc()`; `esc()` remains for the cases not yet
  migrated and for one-off interpolation. `toast(text, ok, {label,onClick})` for
  feedback; `setMsg(id, text, ok)` for inline form messages;
  `confirmDialog(msg, okLabel, kind)` for confirms.
- Cache-busting: `app.js?v=N` + `styles.css?v=N` bumped on every change.
- An **active tournament** (persisted, shown in the context bar) scopes the
  workspace pages; Setup pages are tournament-independent.
- Print/PDF exports open a self-contained styled window that auto-prints (no PDF
  lib); CSV exports build a Blob.
- **Player/Official 360** is a shared modal opened from anywhere a name appears
  (a `_playerCell` formatter + a capture-phase delegated click handler).
- **Inbox grid player columns:** two editable column **groups** — *Player 1*
  (Player + USTA #) and *Player 2* (Player + USTA #2). Double-click a cell to
  manually assign when detection fails: the name cell is a roster dropdown, the
  number cell takes a typed USTA #. Display priority per slot: matched roster
  player → (name, USTA #) parsed from the email text (✉ mark, not rostered
  yet) → bare email-text number; a pairing-avoidance group shows the primary in
  slot 1 and the rest of the group in slot 2. Updates are **full-body PUTs**:
  the endpoint overwrites the detection links with whatever is sent, so every
  PUT carries the row's current `detected_player_id` + `detected_partner_id`
  and omitting a field silently clears it; clearing the primary clears the
  partner; a manually-set partner persists for **any** classification
  (auto-detection only fills it for doubles).
- **Server-side search/paging** on the big lists (inbox, players, officials):
  `q`/`limit`/`offset` + an `X-Total-Count` header on the API; Setup grids opt in
  via `wireEntity`'s `serverSearch` (capped page + "refine" note; the
  `*ById` picker caches are guarded against search-narrowed loads).
- **Floating layers** (searchable-combo lists, anchored row menus) are portaled
  to `<body>` and positioned `fixed` from the trigger's rect so modal
  `transform`/`overflow` can never clip them; background scroll locks while any
  dialog is open.

---

## 9. Auth, sessions & PII

- **pbkdf2-sha256** salted hashes (`pbkdf2_sha256$iters$salt$hash`).
- **Server-side sessions:** a random token in an `HttpOnly; SameSite=strict`
  cookie (`sid`); validated against a `session` table with `expires_at`.
- **Single session per user:** login deletes the user's other sessions
  (session-fixation defense) — note this means two clients logged in as the same
  user invalidate each other. (The test suite resets a process-global login
  throttle between tests because of this; see §10.)
- **Login throttle:** in-process per-`(ip, username)` failure counter → lockout
  after 5 fails / 5 min.
- **Roles:** `admin` (the TD) and `official` (self-service only, linked to an
  `official_id`). `require_admin` gates the back office.
- **PII at rest (`crypto.py`):** Fernet-encrypt email bodies and player
  emails/phones/birthdate; decrypt on read. A dev key is used locally; the boot
  guard refuses prod with the dev key. Retention sweep redacts filed-email PII
  after N days while keeping the provenance row.

---

## 10. Testing

- `pytest`, run against a **separate `courtops_test` DB** (conftest sets
  `PGDATABASE` before `app.config` imports, then migrates + seeds once).
- `test_smoke.py` — one focused test per behaviour/contract.
- `test_td_e2e.py` — one end-to-end walk of the whole TD workflow at the API.
- `test_zz_*.py` — per-feature suites, **named to sort last** so their
  autouse `admin/admin` logins don't pre-empt a still-running earlier module.
- Autouse `_reset_login_throttle` (conftest) clears the in-process login-throttle
  state before each test — it's global and would otherwise leak across tests
  (tests that POST wrong admin passwords could lock the account and 429 a later
  test's login). This fix made the suite deterministic.
- Pattern: `pytestmark = skipif(health.db != "ok")`, an `_ok(r, code)` helper,
  unique ids via `uuid`, dates relative to `today` for clock-independence.
- **`scripts/e2e_td_scenario.py`** — a *black-box* end-to-end driver (separate
  from pytest): an external HTTP client that builds a realistic scenario + the
  challenges a TD hits and asserts each surfaces. Prefers `httpx`, retries only
  idempotent GETs.
- **CI** (`.github/workflows/docker.yml`): every push/PR runs the suite against a
  Postgres 16 service container; the Docker image build is gated on it
  (`build needs: test`), and pushes to `main` publish the image to ghcr.

---

## 11. Rebuild order & scale notes

**To recreate from zero**, follow the phased order (details in
[roadmap.md](roadmap.md)):
1. **Foundations** — Postgres + the migration runner + `0001_core_schema`
   (tournament, site, player, official); the FastAPI app skeleton + `db_dep` +
   the static-frontend mount; auth (migration `0008`, `security.py`).
2. **Officials app (Part A)** — sites/hotels/room-blocks/rates/certs setup;
   tournaments; officials + certifications; assignments with per-day roles +
   the pay/mileage formula + snapshots; availability; the staffing report.
3. **Officials self-service + auto-distance** — the `me` router; great-circle
   mileage estimate.
4. **Email ingestion + review (Part B core)** — `email_message` + the inbox;
   `triage.classify`; player detection; the staged `importer` + the
   `email_targets` registry; per-classification list routers.
5. **Player list features** — late entries, withdrawals (+ alternates), doubles,
   pairing/scheduling/division-flex, player hotels, t-shirt orders.
6. **Polish & hardening** — dashboards, readiness/conflict/coverage reports,
   exports, PII encryption + boot guard + retention, the demo/E2E tooling.

The data model in [data-model.md](data-model.md) is the authoritative schema; the
migrations are the authoritative DDL. Recreating = re-applying the migrations (or
regenerating equivalent DDL) then rebuilding the routers per the patterns above.

**If scaling past the POC:** add a connection pool; replace the no-cache
middleware with hashed asset filenames; move the login throttle + session store
to Redis; consider an LLM (with an explicit cloud-PII decision) behind the
`triage.classify` seam; the Google Maps driving-distance provider behind the
`geocode` seam is already **scaffolded** (migration 0047, key-gated on
`GOOGLE_MAPS_API_KEY`, source `maps`) with the great-circle estimate as the
key-free fallback — finishing it just needs the key + egress + cost sign-off;
split `app.js` into modules if it keeps growing. None of these are needed for a single-TD POC.
