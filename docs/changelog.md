# CourtOps Tennis — UI/UX & polish changelog

Detailed, per-pass record of the UI/UX and polish work. The high-level plan
and status live in [roadmap.md](roadmap.md); this file is the granular log.

---

## 2026-06-13

A heavy build-and-harden day. Grouped by area below; the per-commit detail lives
in git history. The suite grew 428 → **460** green; migrations 0045–0048 landed.

### Payroll: finalization → payment batches (P4-4 + follow-ons)
- **Finalization (migration 0045).** Freezes each assignment's computed pay into
  an immutable `payroll_record` (days, no-shows, pay, mileage, total, rule
  version, day-by-day `detail` jsonb) so later day/rate/no-show edits can't move
  money already approved. Identity denormalized + FK `SET NULL`, so the trail
  outlives the assignment (same policy as `assignment_audit`, whose `action`
  enum gains finalized/unfinalized/paid/unpaid). `routers/payroll.py`: a
  per-assignment summary with a **drift** flag (finalized ≠ live) + orphaned
  records; finalize / finalize-all (idempotent) / unfinalize (refused once paid)
  / mark-paid (date/method/note). Payroll tab with per-row actions + totals.
- **Bookkeeper CSV.** `GET …/payroll/export.csv` — finalized records only,
  utf-8-sig, slugified filename; later gained a trailing **Batch** column
  (LEFT JOIN `payment_batch.reference`).
- **Payment batches (migration 0048).** `payment_batch` table + `batch_id` FK.
  Create a batch from finalized, unpaid, un-batched records (all-or-nothing) →
  marks them paid with one method/date/reference; list with member count + total;
  dissolve walks members back to unpaid (they stay *finalized*; FK SET NULL).
  UI: a New-batch dialog, the batches list, per-record tick selection, and a
  printable **receipt** (`GET /payroll/batches/{id}`) via the `printDoc()`
  scaffold. Each step lands in `assignment_audit`.
- **Assignment-audit CSV.** `GET …/assignment-audit.csv` — the whole tournament
  trail (when / official / action / detail / by), chronological, surviving
  deletes (denormalized identity).

### Dashboard nudges (named, actionable; mailto-only, no send infra)
Beyond the status tiles, the Home board now names *who* to chase:
- **Pending-response** (`GET …/pending`) — unconfirmed officials, each with a
  pre-filled ✉ mailto nudge, plus a "Nudge all" bcc when ≥2 have an email.
- **Roster-completeness** — the named incomplete entries (reusing the existing
  `/roster-completeness`), flagging which fields are missing.
- **Coverage-gap** — which play days have no official (from the dashboard
  payload, no extra fetch). Joins the existing declined-assignments alert.

### Refactors & decomposition
- **`html`` auto-escaping helper (P2 #12) + complete sweep.** New `app/html.js`
  (`html`` → a `Safe` wrapper; `hstr`` → a string for Tabulator formatters;
  `raw()` opts out). Adopted across *every* builder in app.js; the `esc()` count
  fell ~184 → 8 (documented non-template holdouts). 10 unit tests.
- **Unified print-window scaffold.** The 7 TD-facing print/PDF exports collapsed
  onto one `printDoc({title, body, styleExtra, csv, …})` + a shared
  `PRINT_BASE_CSS` (−63 lines; copy-paste drift removed).
- **app.js decomposition (P2 #11, slices b–d).** Extracted `app/auth.js`
  (`createAuth`), `app/state.js` (`createTournamentState` — active-change is now
  an event), and `app/player_list.js` (`createPlayerList`, the shared Part-B
  list factory). Slice (a), grids.js, shipped 06-12.
- **Dead-code removal (high + medium tier).** From parallel backend+frontend
  audits: 3 unreachable single-resource GET routes, 3 unused response models +
  their re-exports, the `deferredSetData` duplicate + 3 unused imports, and the
  `.import-row` / `.ghost` / `details.addbox` CSS. (One over-reach — the 7 nav
  `<symbol>`s — was caught and reverted; see UI fixes.)
- **Inbox Player 1/2 cells.** Single-click edit, a `×` clear affordance, and a
  `＋` add-to-roster on parsed-but-unrostered names; affordances hover-revealed.

### Soft-delete + Trash restore (P2 #13, migration 0046)
Recoverable delete for `tournament` + `tournament_incident` **only** — NOT
players/officials/emails, since `delete_player` is a COPPA PII erasure and
soft-delete there would regress it. DELETE flags `deleted_at` (partial indexes
on active rows); lists filter `deleted_at IS NULL`; new restore endpoints + a
`trash.py` router + a Trash modal in the header. 5 tests.

### Bug hunts & hardening
- **Login user-enumeration via timing** — a missing username short-circuited
  past PBKDF2, returning 401 measurably faster; now both paths pay the hash cost
  against a constant dummy hash.
- **Retention sweep** lacked a negative-`older_than_days` guard (a negative
  window's future cutoff would redact ALL filed-email PII); guarded at both the
  `run_retention` and endpoint layers.
- **Payroll summary** collapsed multiple orphaned (deleted-assignment) records
  onto the single NULL key, hiding all but one; split into a by-assignment map +
  an orphan list (+ denormalized `official_name` to drop an N+1).
- **Soft-delete regression guards** pinned on the digest/deadlines feeds; the
  detection regexes audited ReDoS-safe (<30 ms on 40k-char adversarial input).

### Infrastructure
- **Google Maps driving-distance scaffold (migration 0047).** Key-gated behind
  `GOOGLE_MAPS_API_KEY` (`source='maps'`); degrades to the great-circle estimate
  when unset or on any API error/quota/timeout — mileage feeds pay, so it never
  blocks. No behavior change until the key/egress land.
- **CI Node 24 opt-in.** `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` + `checkout@v5`,
  ahead of GitHub's 2026-06-16 forced switch (scheduled for removal after).

### UI fixes
- **Mobile/day-of responsiveness.** The day-of grids already scroll inside
  `.tbl-scroll`; the lone 375px overflow was the Reports `.report-toolbar`
  (a 731px nowrap row) — `flex-wrap: wrap` took it to 0.
- **Nav-icons regression.** The dead-code sweep removed 7 nav `<symbol>`s that
  app.js references *dynamically* via `createElementNS` (the literal-`<use>`
  grep missed them); restored, with a warning comment.
- **Header button heights** evened (Trash / Change-password rendered at
  browser-default size); **modal-edit dropdowns** raised above the dialog
  (`.combo-list` z 1700 → 1850, `#confirm-modal` → 1900) so the inbox-filing
  combos are no longer hidden behind the modal.


## Inbox doubles intelligence + real-corpus USTA extraction (2026-06-12)
Driven by the TD's actual "Tournament Emails for CourtOps" PDF (30 real
reply-chain emails, now a repo fixture). Suite: **420** green.

- **Doubles partner detection** (commit `05702e0`, migration 0041): a doubles
  email names TWO players, but the inbox only detected one. New
  `email_message.detected_partner_id`; the detector runs the layered match a
  second time with the primary excluded (doubles emails only). Both detect
  endpoints persist the partner; re-classifying away from doubles clears it.
  The inbox Player column renders "X + Y" (each a Player-360 link), Detect/
  Suggest toasts name both, and file-from-email pre-fills the doubles form's
  partner picker.
- **Pairing-avoidance group detection** (commit `15d66c9`, migration 0042):
  pairing emails name a GROUP ("don't pair A with B and C"). New
  `detected_member_ids int[]` (all detected players, primary first; NULL for
  other classifications); the detector loops the layered match, excluding
  everyone found so far, until dry (capped at 6). The grid shows the whole
  group; file-from-email builds one pairing member row per detected player.
- **Real-PDF fixture + pair detection on PDF import** (commit `b1a0d4c`):
  `tests/fixtures/tournament_emails.pdf` (30 real TD emails) with a parse
  contract + real-data detection tests; `_merge_email_pdf` now runs the pair
  detector, so PDF-imported doubles/pairing emails carry the partner / member
  group immediately. The inbox USTA # column stacks both numbers for a
  detected pair (partner's number comes from THEIR roster record) and the
  filter matches either.
- **USTA numbers — one, both, or neither** (commit `34bf777`):
  `extract_ustas()` returns ALL plausible numbers (the old single-number
  extractor gave up on two bare numbers — exactly the doubles case); labeled
  8-digit numbers now qualify as detector candidates; a rostered+stranger mix
  matches the rostered player and still surfaces the unknown number with the
  ✉ mark.
- **Number-before-name detection + first-mentioned-is-primary** (commit
  `cf5acf7`): per the TD's real email structure, a digit run immediately
  before a capitalized First Last ("21043871 Ethan Carter") is a
  high-confidence USTA #; `usta_candidates()` returns numbers in order of
  appearance, so the first-mentioned player is the primary (requester) —
  roster iteration order no longer decides.
- **(name, USTA#) pair extraction — every doubles shape in the corpus**
  (commit `a2d256c`): a survey of all 30 fixture emails found name-first is
  the dominant shape ("* Kate Hampton USTA# 2018840232", "Ava Wright (USTA
  #2018460819)", "Cooper's USTA number is 2018394774").
  `extract_name_usta_pairs()` in `app/email_extract.py` yields ordered
  (name, usta) pairs from both directions with sentence-leak cleanup; the
  grid Player column falls back to the parsed names with the ✉ mark when
  nobody matched the roster. All 5 numbered doubles emails in the corpus now
  yield clean pairs.
- **Inbox grid: Player 1 / Player 2 column groups with manual assignment**
  (commit `5acc0c9`): each group is Player + USTA #, double-click editable —
  pick from a roster typeahead dropdown or type a USTA # directly, covering
  emails detection can't resolve. `EmailUpdate` gains `detected_partner_id`
  (a manually set partner persists for ANY classification); `makeReadGrid`
  gains opt-in editing; Player 2 requires Player 1 first; detail-pane saves
  no longer wipe a detected/manual partner.
- **P2 #11 slice (a) — Tabulator grid factories extracted** (commit
  `d9c2cfc`): the generic grid layer (`wireEntity`, `makeListGrid`,
  `makeReadGrid`, `_autoHeaderFilters`) moves to `frontend/app/grids.js`
  (~445 lines) behind a `createGridFactories(ctx)` seam, shrinking app.js to
  ~7.3k. Factory bodies moved unchanged; verified live in the rebuilt image.

---

## Day-of operations — P4 build-out (2026-06-10 → 06-12)
The top verified gap from the investigation round: everything before and
after an event was covered, but nothing recorded what actually happened ON
the day. Suite grew 386 → 405 over the three slices.

- **Official actual status (P4-1)** (commit `dce0c33`, migration 0040):
  `assignment_day.actual_status` (planned | worked | no_show |
  early_departure). `pay_for()` EXCLUDES no-show days (verified live: pay
  450 → 300 on a no-show day → restored on reset); the frozen pay_audit days
  carry the status, the summary exposes a no_show_days rollup, and the .ics
  feed skips no-show days. UI: each day chip wears its status (no-show struck
  through red, worked green, early dashed) with a status menu.
- **Player check-in (P4-2)** (commit `dce0c33`): `PUT /api/roster/{id}/signin`
  over the existing `signed_in` column — the sign-in SHEET exports stay; this
  records the result in-app. UI: an "In" roster column (click toggles,
  filterable) and a "checked in X/Y selected" counts line — the no-show list
  is one header-filter away.
- **Incident log (P4-3)** (commit `3c55bd3`, migration 0043): the
  tournament's operational memory — weather delays, injuries, disputes,
  facility problems logged as one-liners and resolved in place. New
  `tournament_incident` table + `routers/incidents.py` (open incidents
  first); UI: Tournament → Incidents tab with a quick-log form and a grid
  where typing into the Resolution cell RESOLVES the incident (clearing it
  reopens). Demo seeds a resolved rain delay + an open facility issue.
- **Assignment change audit (P4-5)** (commit `1b6f8c4`, migration 0044):
  pay_audit freezes AMOUNTS; this records ACTIONS — the dispute-resolution
  trail. Append-only `assignment_audit` with tournament/official identity
  denormalized so the trail survives assignment deletion; hooks on every
  mutating endpoint record the acting admin's username (the official portal's
  accept/decline records under the OFFICIAL's login). UI: a History action on
  each card opens a modal table (when / who / what / detail).
- **P4-6 verified false positive** (commit `3dc6dda`): self-service
  dietary/lodging is ALREADY BUILT — `PUT /api/me/profile` updates dietary
  from the portal "My profile" form, and per-tournament hotel-needed rides
  the portal availability flow.

---

## Investigation round + P2 #9/#10/#14 (2026-06-10)
A gap-analysis + issue-hunt + live-probe pass, then three more
improvement-plan items. Suite: 367 → **386** green.

- **Investigation-round fixes** (commit `5a1f780`): **ILIKE wildcard leak**
  (med) — searching "%" or "_" matched EVERY row; new
  `query_helpers.like_escape()` applied at all six sites. **`_rate_for`
  fallback** (high, edge) — work logged before any rate's effective_from was
  paid at the NEWEST rate; the fallback now picks the EARLIEST. **esc()
  hygiene** (low) — four innerHTML sites interpolated counts unescaped.
  Verified clean in the same pass: auth gates, paging edge params,
  room-capacity TOCTOU, parameterized ILIKE, money rounding. The docs commit
  (`e7edb49`) also added the P4 verified-missing-features register
  (day-of-tournament operations) and a round-2 false-positive ledger.
- **P2 #9 phase 1 — pure email-text extractors** (commit `055d7c5`): the six
  pure (subject, body) → value parsers move out of the 745-line emails router
  into `app/email_extract.py` (no-DB), with 11 direct unit tests pinning each
  contract. Move-only.
- **P2 #10 — per-row savepoints for bulk writes** (commit `cf21d0e`): a REAL
  latent silent-data-loss bug — `bulk_populate` caught per-row errors without
  a savepoint, so in Postgres the first failure aborted the whole transaction
  and the request-end COMMIT silently rolled back rows already filed while
  the response still reported `filed: N`. New `app/bulk_ops.py` `savepoint()`
  contextmanager; one bad row now skips just itself (assignments bulk-create
  too).
- **P2 #14 — API contract tests** (commit `b18fd54`): SHAPE assertions on the
  hand-built-dict endpoints (assignment summary, pay-statements, officials
  report) + QUERY-COUNT ceilings via a CountingCursor patched into
  `app.db.get_conn` (assignments 24, players 5, emails 6) — catches
  float-vs-string drift and N+1 regressions before the frontend does.

---

## Improvement-plan execution: P1 round 1 + the money-calc extraction (2026-06-10)
Executing [improvement-plan.md](improvement-plan.md) (suite: **365** green).

- **P1 round 1 — all seven quick wins** (commit `367868d`): empty-Setup-catalog
  callouts with jump links (Assignments/Roster/Room-blocks); terminology pass
  ("Room block (hotel)" label; players-catalog vs roster subtitles); cell-local
  in-grid save feedback (saving-dim + green/red inset flash); global
  constraint-violation handlers (`app/db_errors.py`: uncaught unique→409,
  FK/check→400, +4 tests); `app/query_helpers.paged_select()` shared by
  players/officials/emails; filed-email updates unified through
  `mark_email_filed`; ONE shared outside-click closer for all comboboxes.
- **P2 #8 — assignment money/flag calc extracted** (commit `b21ca10`):
  `app/assignment_calc.py` holds the pure `mileage_for`/`pay_for`/
  `compute_summary`; the router keeps only its queries. 15 direct unit tests
  pin the free band, the $100 cap boundary, missing-distance semantics,
  soft/hard conflicts, and availability rules. Move-only (API money tests
  unchanged).
- Verification note: a preview-harness CDP click-delivery quirk was bisected
  against the committed build and proven NOT an app regression (the cell-editor
  binding works; confirmed via pointer-event sequence on both builds).

---

## Packaging, hardening & list-scaling round (2026-06-08 → 06-10)
Docker/all-in-one packaging, CI, a verified bug-hunt pass, and the next slice
of features (suite: **346** green).

**Shipped to `main`:**
- **All-in-one Docker image** — `postgres:16-bookworm` + venv + app in one
  container; the realistic demo DB is **baked at build time** into a non-volume
  `PGDATA` so the image starts pre-populated. `docker/entrypoint.sh` boots
  Postgres, migrates, seeds only a fresh cluster (`DEMO_RESEED=1` to force).
- **Hosting configs** — `fly.toml` (volume-backed, builds from the Dockerfile on
  Fly's builder), `render.yaml`, `Caddyfile`, and `docs/deploy.md` (ghcr push,
  TLS-at-the-edge, persistence semantics).
- **`ADMIN_PASSWORD` hardening** — env/secret overwrites the admin password at
  seed time AND on every boot (covers the baked image); unset keeps the POC
  `admin/admin`.
- **CI** (`.github/workflows/docker.yml`) — pytest against a Postgres service
  gates the image build on every push/PR; pushes to `main` publish
  `ghcr.io/<owner>/tennis-app:latest`. README badge added.
- **Bug-hunt fixes** (each verified live in the running container):
  searchable-combo dropdowns **portaled to `<body>`** so modal
  `transform`/`overflow` can't clip them (the "1–2 items visible + scrolling
  moves the overlay" bug); background **scroll-lock** while a dialog is open;
  confirm-dialog **z-index** raised above the edit overlay; **CRLF-safe**
  entrypoint (`.gitattributes` + Dockerfile `sed`) so Windows-built images
  boot; **menu-button keyboard nav** (Arrow/Home/End roving, focus-on-open,
  Esc restores focus).

**Feature slice (shipped in commit `8254c8a`):**
- **Server-side search/paging** for Players AND Officials — `q`/`limit`/`offset`
  + `X-Total-Count` on the APIs; `wireEntity` gains an opt-in `serverSearch`
  mode (capped page + "refine" note; the `*ById` picker caches are guarded
  against search-narrowed loads). +9 tests.
- **Retention purge UI** — 🗑 Retention menu in the Inbox (30/90/365-day
  presets behind a danger-confirm) over the existing `POST /api/emails/purge`.
- **iCal schedule export** — `app/ical.py` (RFC 5545); per-official `.ics` from
  the admin assignment cards and `GET /api/me/schedule.ics` ("Add to my
  calendar") in the official portal. Declined skipped; pending=TENTATIVE,
  accepted=CONFIRMED. +4 tests.
- **`markInvalid` offender-first** — cross-field 422s now flag the field named
  first in the error text, not the first match in DOM order.
- Roadmap UI-backlog refreshed (10 stale bullets marked ✅ done);
  `docs/improvement-plan.md` added (design + UI/UX review synthesis,
  commit `676854c`).

---

## TD-review build-out (2026-06-05 → 06-06) — applied
A question-driven round closing the top gaps from a TD-perspective UI/feature
review (full backend suite: **333** green, migrations through **0039**).

- **End-to-end scenario driver** — `scripts/e2e_td_scenario.py`, a standalone
  external HTTP client that simulates a TD's full workflow against a live server
  and asserts each manufactured challenge (uncovered day, cross-tournament
  double-booking, uncertified day, decline, withdrawal→alternate, missing
  distance, no-login, dietary, lodging) surfaces in the right review surface.
  **31/31 checks pass.** Findings + how-to in `docs/e2e-findings.md`.
  - **F1 follow-up:** mileage of `$0.00` with a distance on file (legitimate —
    the first 50 round-trip miles are free) now shows a *"(free band)"* hint on
    the assignment card + pay statements, distinct from the "no distance" state,
    so it doesn't read as a broken calc.
- **Realistic demo data** — `backend/demo_seed.py` builds a believable *live*
  Middle-Georgia junior event (Macon Junior Open 2026 + Rome Junior Classic): a
  staffed 7-official crew with certs/logins/availability/mileage, the full
  32-player roster, a hotel room block, an accept/decline/pending mix, a
  cross-tournament double-booking, a missing-distance + no-login official, and a
  live unfiled inbox — so every screen opens to lifelike activity. Fixed
  `reset_demo.py` to **preserve the migration-seeded reference catalogs**
  (division / event / certification-rate) that a blanket truncate would otherwise
  leave empty.
- **Inbox aging** — the inbox surfaces the **oldest unfiled emails first** with
  days-waiting (`GET /api/emails/aging`, optionally per tournament): a callout
  (shown once the oldest has waited ≥2 days; ≥7 days flagged red) so nothing
  languishes. Clicking an item searches the inbox for it.
- **Missing-distance report** — the Reports tab now consolidates official↔site
  assignment pairs with no mileage on file (`GET
  /api/tournaments/{id}/missing-distances`) — mileage can't compute for them — as
  a table with an **inline miles input + Save** (`POST /distances`); saving
  clears the pair and recomputes mileage. Fixes them all in one place instead of
  card-by-card.
- **Officials needing a login** — the Assignments panel now flags assigned
  officials with no self-service account (`GET
  /api/tournaments/{id}/officials-without-login`) — they can't accept/decline so
  their assignments sit pending — naming them (with a no-email note) and a "Set
  up logins →" jump to Officials setup where the TD creates the account.
- **Official workload balance** — the dashboard now shows a cross-tournament
  workload table (`GET /api/officials/workload`, declared before `/{id}` so it
  isn't parsed as an id): days / assignments / events per official with a load
  bar and accept-decline mix, busiest first, zero-load officials flagged — so the
  TD spots over- and under-used officials when staffing. Each name opens the
  Official 360.
- **Pre-tournament readiness scorecard** — the dashboard now leads with an "are
  we ready?" check (`GET /api/tournaments/{id}/readiness`): one pass/warn/fail
  row per area (day coverage, staffing conflicts, declined assignments, official
  responses, roster completeness, room pickup, inbox) with an overall
  ready/blocker headline. `fail` = hard blocker (uncovered day, double-booking,
  declined slot); `warn` = should-resolve. Each row deep-links to where it's
  fixed. Reuses the dashboard aggregate + `hard_conflict_counts`.
- **Dietary summary for catering** — the Reports tab now rolls up staffed
  officials' dietary restrictions (`GET /api/tournaments/{id}/dietary-summary`):
  grouped case-insensitively, most-common first, each with a count + the names,
  plus a none-count — the catering-ready list. Declined officials are excluded.
- **Self-service availability — quick-select** — officials already set their own
  available dates (`PUT /api/me/availability/{id}`, play-window validated) from
  the self-service page; added the **bulk quick-select** (All / None / Weekdays /
  Weekends) the admin editor already had, so officials declare faster than
  clicking each day. (Pinned the existing endpoint with `test_zz_me_availability`.)
- **Declined-assignment alert** — the dashboard now shows a **named** re-staffing
  alert (not just the count tile): `GET /api/tournaments/{id}/declined` lists who
  declined + the slot they vacated (site + days), most-recent first, and a
  "Re-staff on Assignments →" button that jumps to the Assignments tab and
  pre-filters it to declined.
- **Day-by-day schedule** — the Reports tab now shows a day-of operational sheet
  (`GET /api/tournaments/{id}/schedule`): one block per play-window day listing
  who works (official, role, site) with a headcount and an empty-day flag.
  Declined assignments are excluded (not actually staffed). A **⬇ Schedule**
  toolbar button opens a printable version with an embedded **⬇ CSV** download —
  the day-of sheet to hand to sites.
- **Hotel rooming-list export** — a **⬇ Rooming list** button on the Reports
  toolbar opens a printable per-hotel-block list to hand to the hotel (`GET
  /api/tournaments/{id}/rooming-list`): each official-comp block with its
  occupants (name, the nights they need = their worked-day span, dietary, phone),
  declined assignments excluded. The print window embeds a **⬇ CSV** download for
  hotels that want a spreadsheet.
- **Test stability — login-throttle leak fixed** — the suite had a rare,
  order-independent flake (a self-contained test failing ~1 run in 2, passing in
  isolation). Root cause: `app.routers.auth` keeps failed-login counts + lockouts
  in process-global dicts; under the shared test client every request comes from
  one host, so tests that POST a wrong `admin` password could accumulate ≥5
  failures for the `("testclient","admin")` key and lock the account — making a
  *later* test's autouse `admin/admin` login return 429 (no cookie → misleading
  401 downstream). Added an autouse `_reset_login_throttle` conftest fixture that
  clears that state before each test. **3+ consecutive clean full runs** since.
- **Invite all** — an **✉ Invite all** button on the Assignments response bar
  generates a personalised invite for every assigned official at once (`GET
  /api/tournaments/{id}/invite-texts`, reusing the single-invite composer),
  copies the combined document to the clipboard, and offers a **BCC-all** mailto
  for everyone with an email on file.
- **Batch pay statements (PDF)** — a **⬇ Pay statements** button on the Reports
  toolbar opens one printable statement per assigned official (`GET
  /api/tournaments/{id}/pay-statements`) — each with worked days + rate, mileage,
  and total — plus a tournament grand total: the reimbursement packet the TD
  hands to finance in one click. Reuses the report print-window pattern.
- **Personalised invite text** — each assignment card gained a **✉ Invite**
  button that composes a ready-to-paste email (`GET
  /api/assignments/{id}/invite-text`) with that official's specific worked days +
  roles, the site, and estimated pay/mileage — then copies it to the clipboard
  and (when an email is on file) offers a pre-filled mailto. Beyond the generic
  bulk-invite mailto, which had no per-official detail.
- **Per-official pay statement (PDF)** — the Official 360 drawer gained a
  **⬇ Pay statement** button that opens a reimbursement-grade printable
  statement (`GET /api/officials/{id}/pay-statement`): every assignment with its
  per-day role + rate, the mileage calc (one-way miles → reimbursed), and a
  grand total. Day-level detail beyond the per-tournament pay-summary, via the
  report print-window pattern (no PDF lib).
- **Unmatched-player drilldown** — the inbox progress summary now shows an
  **"N unmatched"** count (still-unfiled emails on a tournament that no roster
  player matched, from `GET /api/emails/status-counts`), and clicking it flips on
  a **server-side** `unmatched=true` filter (`GET /api/emails?unmatched=true`) —
  accurate across the whole inbox, not just the loaded page (the old toggle was
  client-side). The TD resolves detection gaps before triaging.
- **One-click "Triage all"** — a single inbox action (`POST
  /api/emails/bulk/triage`) chains classify → detect-players → populate over the
  selected emails in one request and returns a combined summary (classified /
  matched / filed / left-for-manual). Reuses the three bulk handlers on one
  connection so it can't drift from running them individually — the TD clears
  the unfiled queue in one click instead of three.
- **Bulk auto-classify inbox** — an **Auto-classify** action on the inbox bulk
  toolbar runs the local rule-based triage classifier (`POST
  /api/emails/bulk/classify`, no data leaves the building) over the selected
  emails and writes each one's suggested classification — by default only
  touching still-'unclassified' rows so a manual choice is never clobbered. This
  completes the bulk-triage chain (classify → detect players → populate) so the
  TD can clear the unfiled queue in three clicks instead of editing each email.
- **Conflict count on the dashboard + digest** — a cheap set-based
  `hard_conflict_counts` helper (cross-tournament double-bookings + uncertified
  worked days) now feeds a **staffing-conflict tile** on the per-tournament
  status board and a **conflict chip** in the cross-tournament digest, both
  jumping to the Reports conflict report. Conflicts are now visible from the
  landing page, not just inside Reports.
- **Cross-tournament digest** — the Today dashboard now leads with a digest
  (`GET /api/dashboard/digest`) rolling up **every active tournament** with its
  soonest key date and a tally of open tasks (unfiled inbox, pending/declined
  officials, uncovered play-window days, incomplete roster entries),
  most-urgent first. Each open-task count is a clickable chip that sets that
  tournament active and jumps straight to the relevant tab. Set-based
  aggregates (one query per category), with grand totals across all events.
- **Roster completeness check** — the Roster panel now flags active entries
  (selected/alternate) missing data the TD needs before the event (`GET
  /api/tournaments/{id}/roster-completeness`): missing age division, missing
  player gender (blocks division validation), missing t-shirt size, or an
  outstanding balance. A collapsible banner summarises the gaps with per-issue
  counts; clicking a flagged player loads them into the editor to fix. A
  complete roster shows a ✓.
- **Export Player/Official 360** — both 360 drawers gained a **⬇ PDF** button
  that opens a clean, self-contained one-page profile and auto-prints (TD saves
  as PDF) — reusing the staffing-report print-window pattern, no PDF lib. The
  player export carries entries + filed requests; the official export carries
  certifications + the season assignment/pay table. The 👤 affordance is hidden
  on paper.
- **Assignment conflict report** — the Reports tab now leads with a consolidated,
  grouped list of every staffing clash to resolve before the event (`GET
  /api/tournaments/{id}/conflicts`): cross-tournament double-bookings (hard =
  different site same day, flagged "impossible"), uncertified worked days, days
  worked outside a declared-available window, days outside the play window, and
  hotel-date mismatches — each with the official + date. Aggregates the
  per-assignment flags `_summary` already computes; a clean event shows a ✓.
- **Officials availability heatmap** — the Availability tab now leads with a
  matrix (officials × play-window days) from `GET
  /api/tournaments/{id}/availability/grid`: green cells = declared available, a
  ● = actually assigned that day (amber ring if assigned without declaring
  available), a 🛏 tag for hotel-needed officials, and a footer tallying
  available/assigned per day (empty days flagged) so the TD sees thin days at a
  glance before staffing. **Cells are clickable to staff directly**: a popover
  offers the official's certified roles (or the full list if none on file) and
  one click runs coverage-fill — assign + day in one move, turning the heatmap
  into an action surface.
- **Roster CSV import — discoverable** — the simple hand-typed roster importer
  (USTA #, name, division, status, t-shirt, dietary) is now a first-class option
  on the **Roster panel's ⬆ Import menu** (was buried on the global Import page
  labelled "legacy"), relabelled "Roster (simple CSV)" with a clearer
  description. The staged upload → review → merge flow and templates were
  already in place; this surfaces them where the TD seeds the roster.
- **Coverage gap → invite** — a fixable cell on the role-coverage grid (a day
  undercovered for a role while certified officials are free) is now **clickable**:
  a popover lists certified officials not already working that day (`GET
  /api/tournaments/{id}/coverage-candidates?role=&date=`), ranked
  available-first and tagged *available / already-on-event / busy-elsewhere*. One
  click **fills** the gap (`POST /api/tournaments/{id}/coverage-fill`) — assigns
  the official (creating a pending assignment if needed) and adds the (date,
  role) day atomically, with the cert guard + pay snapshot.
- **Withdrawal → auto-suggest alternate** — recording a withdrawal now surfaces
  an inline panel of alternates to promote (`GET
  /api/tournaments/{id}/alternates?age_division=`): the withdrawing player's
  **same division first, tagged "best match"** (FIFO order = next in line), then
  other divisions under a separator. Each row has a one-click **↑ Promote to
  selected** (reuses `POST /api/roster/{id}/promote`) + a 👤 Player-360 link.
- **Bulk official invites** — a collapsible picker on the Assignments panel
  lists every not-yet-assigned official (filter + select-all-shown); `POST
  /api/tournaments/{id}/assignments/bulk` creates one **pending** assignment per
  selected official in one call (idempotent — already-assigned ids are skipped,
  invalid ids reported), then offers a **single mailto** BCCing everyone just
  invited. The dashboard officials response-mix tile is the status rollup.

- **"Today" home dashboard** — a landing page (`GET
  /api/tournaments/{id}/dashboard`) aggregating the existing data: inbox
  unfiled/filed/follow-up counts, roster mix, officials response mix, uncovered
  coverage days, and room pickup — each tile deep-links to its panel.
- **Approaching-deadline banner** — cross-tournament `GET
  /api/dashboard/deadlines?within_days=` surfaces registration / late-entry /
  play-start dates inside the window (plus a 3-day "just passed" grace), sorted
  by date, on the dashboard.
- **Player 360 drawer** — `GET /api/players/{id}/overview` opens one player's
  full picture (all tournament entries + Part B requests) in a modal, reachable
  from **anywhere** a player name appears (Part B lists + inbox), via a shared
  `_playerCell` formatter + capture-phase click handler.
- **Alternate promotion** — `POST /api/roster/{entry_id}/promote` flips an
  alternate to selected in one click, with a withdrawal-nudge toast that points
  the TD at the alternate list.
- **Global search** — the top-bar box now finds **players and officials**
  (`GET /api/players/search`, `GET /api/officials/search`), tagged by type;
  an official result opens an **Official 360** drawer (`GET
  /api/officials/{id}/overview`) with certs held + the season assignment/pay
  summary (reuses `pay_summary`).

---

## Staffing-confidence build-out (2026-06-05) — applied
An iterative, question-driven round focused on giving the TD confidence the
event is correctly staffed — every assignment-quality signal, the response loop,
and coverage visibility. All on the `official-season-pay` branch; backend suite
**147 → 174** green (one new `test_zz_*` module per feature). Each was verified
live in the running app, not just by tests.

- **Assignment quality flags** (warn, never block — consistent with the
  off-window/hotel-date policy):
  - **Availability mismatch** — a worked day the official didn't declare
    available is flagged (per-day ⚠, card chip, report count). Suppressed when
    they declared nothing. (`days_outside_availability` / `has_availability_data`.)
  - **Certification guard** — the assign path already 409s an uncertified role;
    a cert *revoked after* booking now also flags the day (card chip + per-day ⚠
    + report `uncertified_count`). The add-day form pre-checks held certs and
    blocks early with a friendly message. (`held_certs` / `uncertified_days`.)
- **Response loop** (accept/decline):
  - **Decline visibility** — Assignments panel response-status summary + filter
    chips (All/Pending/Accepted/Declined, declines first); report
    `declined_count`/`pending_count`; DECLINED flagged inline on the roster.
  - **Reassign from a declined slot** — one click pre-fills the add-form with the
    same site/hotel (official cleared) and copies the declined days onto the
    replacement; the declined row stays as an audit trail.
  - **Chase pending responders** — the summary carries the official's email/phone;
    a "✉ Email N pending" mailto BCCs all non-responders, and each pending card
    shows an "awaiting response · email · phone" line (mailto/tel).
- **Availability tooling**:
  - **Bulk quick-select** — All / None / Weekdays / Weekends + an additive
    from–to range on the Availability tab.
  - **Availability-vs-assigned gap** — an "Assigned" column + callout on the
    Availability tab, and a mirrored nudge on the Assignments panel (with a jump
    link), naming officials who offered dates but aren't staffed.
- **Coverage visibility** (report):
  - **Per-day coverage** — an "Officials per day" footer row (zero-days red) +
    a callout/PDF note listing uncovered days. (`coverage`/`uncovered_days`.)
  - **Per-site coverage** — a site×day grid (every linked site + a "(no site)"
    row), zeros red. (`site_coverage`.)
  - Both surfaced in the **PDF** and appended to the **CSV** export.
- **Room-block pickup** — the report shows rooms reserved vs assigned (pickup) vs
  unused per official comp block + a release-before-cutoff warning; **declined**
  assignments are excluded from pickup (a declined official frees the room).
- **Auth** — **change-own-password** for any logged-in user
  (`POST /api/auth/change-password`): verify current, set new (≥8, must differ),
  invalidate other sessions, keep the caller's. Header button → modal.
- **Review pass** — a branch code-review caught + fixed two bugs: declined
  assignments inflating room pickup, and a response-filter that stuck across
  tournament switches (now per-tournament).
- **Inbox USTA #** — the inbox parses the player's **USTA #** straight from the
  email text (`detected_usta_text`, prefers a labeled number, falls back to a
  lone bare 9–11 digit run) and shows it in a dedicated **USTA #** grid column —
  visible for PDF-imported emails even before a roster player is matched (a ✉
  glyph marks an email-only number). The matched player's number takes
  precedence once detected.
- **Auto-detect on PDF import** — the emails_pdf merge now runs the same player
  detector the "Detect" button uses, so a PDF-imported inbox opens with players
  + USTA #s already populated (no per-row click). A no-match leaves the row blank
  as before; dedup + classification unchanged.
- **Server-side USTA search** — the inbox `q` now also matches the player's USTA #
  (both the matched player's number and the one parsed from the email). The
  email-text USTA is persisted (migration 0039 `detected_usta_text`, populated on
  insert/import; pre-existing rows lazily backfilled on read) since the body is
  encrypted and can't be searched in SQL.
- **Add to roster from an email** — an inbox row that carries a USTA # but matched
  no roster player gets an "Add player to roster" action: it jumps to the Roster
  tab and opens the new-player form pre-filled from the email (USTA #, name if
  known, parsed division + gender inferred from a B/G division code), so the TD
  just confirms + Saves. Reuses the existing roster upsert.
- **One-click "Detect players"** — an inbox toolbar button runs the detector over
  every loaded email with no matched player (and a tournament), in one call to
  the existing `bulk/detect-players` endpoint — no per-row selection. Reports how
  many of the unmatched it resolved.
- **USTA # into filed forms** — when filing a late-entry/withdrawal from an email,
  the player picker is pre-selected by the detected USTA # (precise even when two
  players share a surname), falling back from the linked player. Pure resolver
  (`resolveFilePlayerId`) with node-test coverage.
- **Inbox progress summary** — the inbox shows an at-a-glance status line
  ("N unfiled · M filed · K need follow-up · T total") from a new lightweight
  `GET /api/emails/status-counts`. (Per-email filed status, filed-on-save, and the
  status filter already existed; this surfaces the aggregate "what's left to
  process".) The unfiled count links to the new-only filter.
- **Re-detect after add-to-roster** — once "Add player to roster" saves, the
  source email is re-run through the detector and links to the just-added player
  automatically (no manual "Detect"). Best-effort: the roster save itself always
  succeeds even if the follow-up detect hiccups.
- **Off-roster USTA match** — detection used to search only the tournament roster;
  it now adds a final high-confidence layer (`usta_offroster`) that matches a
  player who exists in the system but isn't entered in this tournament (USTA # only
  — never a bare name). The inbox flags it and the "Add to roster" action opens
  pick-existing mode pre-selected, so the TD adds the existing player in one step.
- **Report coverage trio** — the staffing report gained **per-role coverage by
  day** (`role_coverage` — officials per role per day, thin/zero highlighting), a
  per-official **Days column** + grand total (`official_days_total`), and a
  **certification pool** matrix (`cert_pool` — every official × the certs they
  hold + holder counts, zeros flagged) so the TD plans role coverage against the
  available pool. Coverage grids on screen + PDF (+ CSV for the day-aligned ones).
- **Cert-pool gap flag** — the role-coverage grid now ties to the pool: each role
  row shows "(N certified)" and rows include roles with holders even if unstaffed
  (an all-zero row surfaces "you have chairs but staffed none"). A day undercovered
  for a role while more certified officials are available is flagged with a ⚑
  ("you can staff more"). (`role_coverage[].holders`.)
- **Inbox "Unmatched only" filter** — a toggle filters the inbox to emails with
  no matched player (combines with the status/tournament filters), so the TD works
  through detection gaps.
- **Player-request origin** — all the Part B lists (late-entry, withdrawal,
  scheduling-avoidance, division-flex, player-hotels, doubles, pairing) gained an
  "Origin" column: "✉ email" (tooltip = the filed email's subject, joined in via
  `source_subject`) vs "manual", so the TD sees which requests came from a filed
  email.

---

## Benchmark-driven build-out (2026-06-04 → 06-05) — applied
A large round of fixes + features (full backend suite: **207** green, migrations
through **0039**). Driven by a UI/design review + a competitor-benchmark research
pass ([roadmap.md](roadmap.md), [pii-hardening-plan.md](pii-hardening-plan.md)).

- **Inbox / Part B filing** — fixed bulk-populate's `scheduling` key drift;
  single-file pre-fills the detected player; a single **email-target registry**
  (`app/email_targets.py`, `GET /api/emails/targets`) is the source of truth for
  single-file + bulk (drift-guarded); **local field extraction** (age division,
  events, scheduling day/time) surfaced + filled on filing and bulk; filing uses
  the **email's own tournament**; **correction handling** (`amends_email_id`,
  ↻/⤺ badges) + **auto-rewrite** (update the amended row in place);
  **server-side search/pagination** (`q`/`limit`, `X-Total-Count`).
- **Assignments** — cross-tournament **double-booking detection** (chip + per-day
  marker + report count + add-time confirm); add-day-row a11y polish; **money
  audit trail** (`pay_audit` jsonb freezes calc inputs, §5.3).
- **Officials** — player-PUT **optimistic-concurrency** false-409 fix;
  **accept/decline** assignments (self-service → TD chip); **per-official season
  pay** summary; **auto-distance** great-circle estimate + geocoder seam.
- **PII hardening (COPPA)** — `pii-hardening-plan.md`; **H1** boot guard
  (refuses default creds / non-TLS / dev key in prod) + `sslmode`; **H2** column
  encryption (email body, player emails/phones/birthdate); **H3** history
  erasure on delete + email-body purge + policy-driven retention sweep.
- **Staff** — non-official `tournament_staff` (roster + role) in the staffing
  report; **per-day scheduling** (day-grid) + **daily pay**.
- **Auth** — **multi-user TD access** (admin account management).
- **Reports** — **PDF export** of the staffing plan (print-window, no lib).

---

## Earlier history (through 2026-06-03)
Granular per-pass log for 2026-05-25 → 06-03 work, collapsed. All shipped and
in production; superseded detail lives in git history.

- **Setup catalogs & schema** — tournaments/sites/officials/players/rates/hotels/
  distances CRUD; gender (required), configurable divisions + events, t-shirt
  inventory/orders, player-hotels, staged CSV importer with round-tripping
  exports (migrations ~0017–0044).
- **Master/detail UI** — every Setup + workspace page moved to full-width
  Tabulator grid + modal edit form; Roster master/detail; single-click in-grid
  edit; per-column header filters; auto-fit column widths; Inbox became a grid.
- **Navigation / density / a11y** — grouped tournament nav (Tournament /
  Staffing / Player requests); status color chips; toasts; global loading bar;
  ARIA dialogs (`role="dialog"`, focus management); `:focus-visible` rings;
  arrow-key tablist; icon-only Edit/Delete; sticky headers + zebra striping;
  dark-mode token bump to AA contrast.
- **Lists & import/export** — Part B PUT + in-grid editing (late entries,
  withdrawals, scheduling, division-flex, player-hotels; pairing/doubles stay
  add/delete); Setup CSV export round-trips the importer; confidential
  initials-only hotel report; realistic demo data.
- **Robustness fixes** — session expiry/invalidation (migration 0017), login
  rate-limit + lockout, `secure`+`samesite=strict` cookies + session rotation;
  N+1 report query removed; off-window-day flagging; availability/doubles
  validation (400 vs 500); `rooms_remaining` consistency.
- **Audit rounds (D1–D8) + 8 critique passes** — full code+docs audit follow-ups
  plus 8 design/code critique passes closing ~130 line-level findings
  (security, data integrity, consistency, docs); `audit.md` retained as the
  D1–D8 archive; `design-audit.md` folded into this changelog.
- **UI/UX polish passes 1–19** — incremental frontend polish: master-detail
  proportions, collapsible add-forms, styled delete confirm, busy-on-submit,
  numeric right-alignment, button consistency, empty-state polish, and the
  remaining UI-review backlog (pass 18 roadmap correctness gaps, pass 19
  backlog cleanup).
- **End-to-end + docs** — a full TD-workflow smoke test; docs consolidation
  (`data-model.md`, `README.md`, this changelog) brought current.

_Full granular detail for this period is in git history._
