# CourtOps Tennis — changelog

The chronological log of shipped work — features, refactors, hardening, and
UI/UX polish. The high-level plan and status live in [roadmap.md](roadmap.md);
this is the granular record (per-commit detail beyond it lives in git).

Newest first. Recent days are grouped by theme; earlier rounds are kept as
dated entries; pre-2026-06-04 history is digested at the bottom.

---

## 2026-06-14

A UX round driven by a senior-UX usability pass: three builds, smallest-risk
first, each shipped + CI-verified on its own. The suite grew 460 → **469**
green; migration 0049 landed.

### Outreach memory — "did I already chase this person?" (migration 0049)
The dashboard's pending list now remembers when each non-responding official was
last nudged. `assignment.last_nudged_at` (migration 0049); `POST
…/assignments/{id}/nudged` marks one and `POST …/tournaments/{id}/pending/nudged`
stamps every pending row (the "Nudge all" bcc flow). A reply
(`/api/me/.../respond`) clears the mark so it never reads stale. `/pending`
returns `last_nudged_at`; the Needs-attention list shows "nudged today" /
"nudged Nd ago" and records the timestamp on click.

### IA cleanup — organize the nav by where work lives
- **Disambiguated duplicated tabs.** The Tournament group's `Sites`/`T-shirts`
  collided with the Setup *catalog* tabs of the same name → renamed to **Event
  sites** / **Shirt order** so the split reads as catalog-vs-event.
- **Merged "Player requests" + "Player preferences"** into one **Player lists**
  L1 group (six groups instead of seven). The `#i-requests` sprite became
  `#i-playerlists` (referenced dynamically as `#i-${group}`).
- **Count badges.** `GET …/nav-counts` (one batched query) drives a chip on each
  of the seven Player-list tabs plus the Inbox tab and L1 button — hidden at
  zero, refreshed on tournament switch / group entry / counted-tab open.

### Doubles detection — find BOTH players with more methods
A doubles email names two players, but the partner often went unmatched because
player matching was exact-substring only. Added a normalized **fuzzy name**
fallback layer (L8) to the roster detector + a name-only span extractor
(`extract_names`), so detection now also resolves: `Surname, First` inversions,
a middle name/initial (`Maya R. Quintero`), accents and apostrophes
(`Renée O'Brien` ↔ `Renee OBrien`), multi-word surnames, and partners named
without a USTA # (`…partner with Zara Hollis`). The fuzzy layer fires only after
the precise layers (L1–L7) come up empty and requires a *unique* roster hit, so
existing high-precision matches are unchanged. Flows through the PDF-import
auto-detect path too. +5 tests.

Follow-up: the name↔USTA-# adjacency now binds across whatever "skip" glue a PDF
puts between them — multiple symbols, a label, parentheses, **a line break**, no
space — in **either** order (`<name><skip><number>` / `<number><skip><name>`),
so both players' numbers are found when the old narrow bridge (single separator
+ required space) missed the second. Letters never ride in the gap, so a number
can't bind to a name across other words. +3 tests.

Follow-up 3 (validated against the real `tests/fixtures/tournament_emails.pdf`
corpus): ran detection over every doubles email in the export. Both players now
auto-resolve on **15 of 19** (the rest are a parser-truncated body, a
first-name-only partner, a "still looking for a partner" note, and a non-pair
thread reply). Two precision fixes fell out of the corpus: the connected-pair
extractor now requires a doubles/partner/pair keyword **near** the two names
(so an email signature like "David Pantovic ATP & WTA Tour Coach" or
"Simplicity Investments, Member FINRA" can't pose as a pair), drops the noisy
comma connector, trims credential/org tokens (ATP/WTA/PhD/CEO/…) off captured
names, and accepts a short "…is partnering **with**…" filler clause. +3 tests.

Follow-up 2 (the real corpus): most doubles requests name the two players with
**no USTA # at all** — "Mia Langone and Chelsea Ie would like to pair up",
"pair Ankush Kotti with Watts Goodman". New `extract_doubles_pair()` finds the
two names joined by a pairing connector (`and` / `with` / `&` / `/` / `+` /
comma — a hyphen is *not* one, so "Leilei - Mia's mom" sign-offs don't pair).
The detector tries that pair first; and when a player isn't on the roster yet,
**both names now surface in `detected_name_pairs`** (name + no number) so the
inbox grid shows the full pair with the ✉ "not rostered" mark for the TD to
confirm / add — previously a name-only pair surfaced nothing. +2 tests.

### Day-of mode — the on-site venue view (full first cut)
A new **Day-of** L1 group (promoted near the top — it's where the TD lives once
play starts) with a tablet-friendly venue view for one calendar day. `GET
…/day-of?on=YYYY-MM-DD` (defaults to today) aggregates everything in one call;
mutations reuse existing endpoints. Big-touch (≥44px) controls:
- **Date bar** with ◀/▶ stepper, a *today* badge, *during play / outside play
  window*, and jump-to-today.
- **Summary strip** — officials working, checked-in, sites covered, room pickup,
  player sign-in.
- **Live coverage gaps** — sites with no official today, plus **quick-assign**
  (pick a role → certified-and-free candidates from `/coverage-candidates` →
  one tap fills via `/coverage-fill`).
- **Officials working** — response chip + big **✓ Present / ✗ No-show** toggles
  (write `assignment_day.actual_status`), with a name filter.
- **Incidents** — a one-tap quick-log form + the day's incident list.

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

### UI polish & mobile support (later same-day)
A usability/UI review pass plus follow-ups, all frontend-only and verified live
at desktop + 375px.

- **Dark-mode legibility fix.** `--btn-bg` / `--panel` / `--line` were never
  defined in `tokens.css` — only as light literal fallbacks in `styles.css` — so
  dark mode inherited light surfaces and the dashboard nudge-card buttons + the
  digest panel rendered near-invisible. Defined per-theme (contrast → ~11–14:1).
- **Touch affordances.** The hover-revealed row controls (editable-cell ✎, the
  inbox ✎/×/＋) are now always shown under `@media (hover: none)` — they were
  undiscoverable on a tablet.
- **Dashboard density.** The named nudge cards (declined / pending / roster /
  coverage) now flow into a responsive `.dash-attention` grid instead of a tall
  stack; the **active-tournament** context bar gets a brand-ball accent stripe;
  and the Home (119→0) + Payroll (157→~3) mobile overflows were fixed (the
  dashboard tables scroll in a wrapper, the Tabulator grid caps at its card).
- **Sticky grid sort.** Tabulator sort persists per-table (`persistenceID`
  `courtops-v1-<table>`); sort-only (filter persistence would fight the inbox's
  load-time defaults), inbox opted out.
- **Icon prev/next on edit modals.** The record-nav text buttons ("‹ Prev" /
  "Next ›") became icon-only chevrons, kept clear of the top-right close ×;
  applied across all grid edit modals (the 9 `wireEntity` Setup grids + roster).
- **Richer grids + responsive collapse (mobile).** Added columns to the sparse
  Setup catalogs (Officials +Phone/Email/Dietary, Players +City/St) and turned
  on Tabulator **responsive collapse** in the grid factories: extra columns show
  on desktop and fold into a tap-to-expand **▸** row on phones (no
  horizontal-squish). A shared helper prepends the ▸ toggle and pins the
  interactive columns (edit/delete actions, the batch checkbox) + the identity
  column always-visible. The inbox opts out (its Player 1/2 column groups); the
  toggle uses the brand accent.


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

## 2026-06-04 → 06-06 — TD-review build-out (digest)

Three dense, question-driven rounds (benchmark-driven → staffing-confidence →
TD-review) that built out most of the operational surface. Suites converged to
**333 green** through migration **0039**; each feature was verified live. Digested
here by area; the full per-feature prose is in git history.

- **Dashboard & readiness** — the "Today" status board (`/dashboard`), the
  cross-tournament **digest** + approaching-**deadline** radar, a pass/warn/fail
  **readiness scorecard**, cross-tournament **workload balance**, staffing
  **conflict counts**, and the named **declined-assignment** re-staffing alert.
- **Reports** — the consolidated **conflict report**; the coverage trio
  (per-day / per-site / per-role grids + a **cert-pool** matrix with gap flags);
  the **missing-distance** fix-inline report; the **dietary summary**; the
  day-by-day **schedule** and hotel **rooming list** (printable + CSV); **batch
  pay statements** + the staffing-plan **PDF**; **room-block pickup** (declines
  free rooms).
- **Assignments & the response loop** — self-service **accept/decline** with
  TD-side filters, **reassign-from-declined**, a **chase-pending** mailto, **bulk
  invites** + per-official **invite text**; assignment-quality flags (availability
  mismatch, post-booking **cert** revocation) as warnings; cross-tournament
  **double-booking** detection; and a **money audit trail** (`pay_audit`).
- **Officials** — per-official **season pay** + a reimbursement **pay-statement
  PDF**, the **officials-without-login** flag, **auto-distance** estimate +
  geocoder seam, the optimistic-concurrency false-409 fix, the **availability
  heatmap** (clickable to staff) + quick-select + assigned-gap nudge,
  **change-own-password**, and **multi-user TD access**.
- **Inbox / Part B** — an **email-target registry** as the single source of
  truth, local field **extraction**, **correction**/auto-rewrite, server-side
  **search + pagination**, **USTA #** parse/search/column, **auto-detect on PDF
  import**, one-click **detect-players** / **triage-all** / **auto-classify**, an
  **unmatched** filter + drilldown, **add-to-roster-from-email**, **off-roster
  USTA** match, **inbox aging**, the progress summary, and a request **origin**
  column on every Part B list.
- **Players & roster** — **Player/Official 360** drawers (+ PDF export), top-bar
  **global search**, **alternate promotion** + **withdrawal→alternate** suggest,
  the **roster-completeness** check, a discoverable **roster CSV import**, and the
  **coverage-gap→invite** one-click fill.
- **Staff** — non-official `tournament_staff` in the staffing report, with
  per-day scheduling + daily pay.
- **PII hardening (COPPA)** — **H1** boot guard (refuses default creds / non-TLS
  / dev key in prod) + `sslmode`; **H2** column encryption (email body, player
  emails/phones/birthdate); **H3** history erasure on delete + email-body purge +
  a policy-driven retention sweep. (Plan in `pii-hardening-plan.md`.)
- **Quality** — the standalone **e2e scenario driver**
  (`scripts/e2e_td_scenario.py`, 31/31 checks), a realistic **demo_seed**, and the
  login-throttle test-leak fix.

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
