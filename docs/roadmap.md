# CourtOps Tennis — Build Roadmap

A phased plan to go from the vision to a working system. Ordered so that each
phase delivers something usable on its own and de-risks the next. Cross-refs:
[vision-summary.md](vision-summary.md) · [audit.md](audit.md) ·
[data-model.md](data-model.md).

---

## Guiding principles
- **Two halves, loosely coupled.** Officials app (Part A) and player-email
  operations (Part B) share only `Tournament`/`Player` concepts. Build A first —
  it's well-specified and has no AI/email dependency.
- **Manual-first, automate-later.** Every place the vision implies an
  integration (mileage distance, email ingestion, USTA), ship a manual path
  first so the tool is useful before the integration exists.
- **Provenance everywhere on Part B.** Every extracted row links to its source
  email for audit, dedup, and corrections.
- **Minors' PII is a design constraint, not a feature.** See audit §5.

---

## Stack decision (D6) — POC stack confirmed
The proof-of-concept (POC) is a small, conventional 3-tier app. **No agent/LLM in
scope** (D5/§5.1: email is human-reviewed, not parsed).

- **Database:** **PostgreSQL**, running on **localhost** with the **default admin
  credentials** for the POC. *(POC convenience only — see the security note below.)*
- **Frontend:** **pure HTML/CSS** (no JS framework). Plain pages that call the API
  via `fetch`; keep it dependency-free for the POC.
- **Backend / API:** a **Python server** exposing JSON endpoints the HTML pages
  call (e.g., FastAPI or Flask — pick one at Phase 0), talking to Postgres.
- **Part A (officials):** these pages + API — CRUD, calculations, reports.
- **Part B (player ops):** the same app — forwarded email lands in a **review
  inbox**; the TD/staff file each message into the right list. **No automated
  parsing.**
- **Future enhancement:** an **email-triage agent** (Claude Agent SDK or Google
  ADK) that auto-classifies/extracts into the same tables — added only if/when
  automated parsing is approved (revisits D5 cloud-vs-local then).

> ⚠️ **Security (post-POC):** localhost Postgres on default admin credentials is
> acceptable *only* for a local POC. Before any shared/hosted deployment, move to a
> dedicated DB user with a strong secret (env-var/secret manager, not in code),
> least-privilege grants, and TLS — this is required to honor the encryption /
> non-public constraints for minors' and officials' data (audit §5.1/§5.3).

---

## Phase 0 — Foundations  *(prereq for everything)*  ✅ DONE
- [x] **All decisions D1–D8 are made** ([audit.md](audit.md) §7) — no open items.
      D5 resolved: **no automated parsing; email is human-reviewed** (the agent is
      a future enhancement).
- [x] Scaffold the POC stack (D6): **Postgres** on localhost (default admin creds
      for now), a **Python API server** (FastAPI + uvicorn), and **pure HTML/CSS**
      pages that call it. DB migration runner + pytest harness in place (`backend/`).
- [x] Implement core schema: `Tournament` (with `registration_deadline`,
      `late_entry_deadline`, `play_start_date`/`play_end_date` — audit §2.5),
      `Site`, `Player`, `TournamentEntry` (TD roster), `Official`
      (`backend/migrations/0001_core_schema.sql`).
- [x] Seed/fixtures + a smoke test (`backend/seed.py`, `backend/tests/test_smoke.py`).

**Done when:** schema migrates cleanly and a tournament + site can be created.
**✅ Verified:** `migrate.py` creates the `courtops` DB and applies the schema;
4 smoke tests pass; the server serves the API + HTML page and creates sites/
tournaments end-to-end.

---

## Phase 1 — Officials app, administrator side  *(highest, clearest value)*  🚧 IN PROGRESS
- [x] TD CRUD: tournaments (name, type, the three dates above + match-play
      window, site), sites. *(full CRUD + filters, master-detail UI)*
- [x] **Per-tournament roster import** (`TournamentEntry`): **CSV/XLSX upload**
      (`POST .../players/import`) upserts players by USTA ID + their entries
      (status, t-shirt, dietary), tolerant header matching; plus manual add/edit
      (audit §3.8). Foundation for the alternate list, t-shirt history, Part B.
- [x] **Official certifications** (migration 0006): held certs on the Official
      detail; assignment-day role is constrained to held certs (audit §3.2).
- [x] `CertificationRate` management (**per-day rate per certification** — D2).
      *(migration 0002, `/api/rates` CRUD, Rates tab, seeded roving/chair/referee)*
- [x] `HotelRoomBlock` inventory with `room_count`. *(migration 0002,
      `/api/hotels` CRUD, Hotels tab; block scoped to a tournament via
      `tournament_id`)*
- [x] Official records (created by TD initially; self-service in Phase 2).
      *(Officials tab, full CRUD)*
- [x] **Tournament hub + mappings**: tournament can use **>1 site**
      (`tournament_site` M2M); per-tournament **roster** (`tournament_entry`);
      hotels **split** into `hotel` + `room_block`. Managed in a tournament-centric
      detail view. *(migration 0003; nested APIs; hub UI)*
- [x] **Assignment** flow: assign official to a tournament with a venue **site**
      and optional **room block**, with a **per-day role** (`AssignmentDay`) so the
      position can change day-to-day (audit §3.2). Hotel date mismatches surface as
      a `hotel_date_mismatch` flag, not a block (audit §3.4).
- [x] **Pay & mileage calc**: pay = Σ per-day rate for the role worked each day
      (audit §3.2); mileage = `clamp((2·one_way−50)×0.65, 0, 100)` with the $100 cap
      a **hard ceiling** (D1/§3.1); mileage is null/blocked when no
      `OfficialSiteDistance` is on file (`missing_distance`, audit §3.7 S4).
      *(computed in the assignment summary; verified pay 350 + mileage 97.5 = 447.5)*
      Google Maps geocoding remains the Phase 2 auto-source (D3/U2).
- [x] **Seed/backfill the `OfficialSiteDistance` matrix** from
      `Officials Mileage Workbook.xlsx` — `backfill_distances.py` imports officials
      + distances (one-way = `(reimbursable+50)/2`), skipping the `182` placeholder
      and blanks. First run: **47 officials, 38 distances, 6 placeholders skipped**
      (audit §3.7 S4/S6).
- [x] **Reports**: officials confirmation & pay report — per-day roles, site,
      hotel, **dietary** column (audit §2.3), **missing-distance** + **hotel
      date-mismatch** flags (audit §3.4), and pay/mileage **totals**. Print
      (print stylesheet) + **Export CSV**. *(`/api/tournaments/{id}/reports/officials`,
      Reports tab.)*

**Done when:** TD can staff a tournament end-to-end and print both reports.
**Status:** ✅ core path complete — staff a tournament (roster, assignments with
per-day roles, hotels) and print/export the officials report. Remaining Phase 1
polish tracked in the backlog below (distance backfill, room-count enforcement,
pay snapshots).

---

## Phase 2 — Officials self-service + auto-distance  🚧
- [x] **Official auth + self-service** (migration 0008): cookie-session login
      (pbkdf2), `admin`/`official` roles, role-split UI. Officials edit their own
      profile and set per-tournament **availability** via `/api/me/*`; admin sets
      an official's login from the Official detail.
- [x] **Availability** — both **TD-side** (Availability tab, migration 0007) and
      **officials' own** (self-service).
- [x] TD sees availability when making assignments — the Assignments official
      picker shows each official's available-day count for the tournament, and the
      day picker offers their available dates.
- [ ] **Google Maps geocoding** to auto-compute home↔site round-trip distance
      (the primary mileage source), with **manual entry as fallback** when the
      lookup is unavailable (D3/U2).

**Done when:** officials self-declare availability and TD assigns from it.

---

## Phase 3 — Email ingestion + human review (Part B core)  🚧
The player side starts as a **human-review workflow — no automated parsing**
(D5/§5.1). The TD forwards player/parent email to a dedicated address; it lands in
a review inbox; a person files each message into the right list.
- [~] Ingestion: **POC manual add** to the inbox (migration 0011). Dedicated
      forwarding-address auto-ingest still 🔭 (D4).
- [x] `EmailMessage` provenance + dedup by `message_id`.
- [x] **Review inbox UI** (Inbox tab): add a message, set `classification`, **file**
      it into a list (no auto-extract); filing sets the email `status='filed'`.
- [ ] Minors' data encryption at rest + access control (Phase 5; access-control via
      admin auth is in place).

**Done when:** a forwarded email reliably appears in the review inbox and a person
can file it into a structured, provenance-linked row.

> **Triage agent — v0 built (local, D5-safe):** a rule-based suggester
> (`app/triage.py`, `POST /api/emails/{id}/suggest`) proposes a classification from
> keywords — **no LLM, no data leaves the building**; the inbox "Suggest" button
> sets it and a human confirms. **Still open (D5):** upgrading to an **LLM** that
> reads email content needs the explicit cloud-vs-local privacy call first.

---

## Phase 4 — Player list features (built on the review inbox)
Each is a filing form (from the review inbox) + a list view + an export. Suggested
order (simplest first):
- [x] **Late entries** (migration 0011) — list + manual add + **file-from-email**;
      upserts the player and their `TournamentEntry` (`source = late_entry`), marks
      the source email filed (audit §4.1).
- [x] **Withdrawals** (migration 0012) — list + manual add + **file-from-email**;
      reason required unless the player was an alternate; flips
      `TournamentEntry.selection_status = withdrawn`; `was_alternate` snapshotted
      (audit §2.4).
- [x] **Scheduling avoidances** + **Division flexibility** (adults) — migration
      0013; list + add + file-from-email (generic inbox target picker).
- [x] **Pairing avoidances** (juniors, migration 0015) — group of 2+ players
      (header + members), relationship same_club/siblings; list + multi-member add
      + file-from-email (audit §1.1).
- [x] **Doubles pairing** (migration 0016) — mutual two-sided verification (a
      reciprocal pending request creates a verified pair) + **random FIFO queue**
      (binding); odd requester stays pending (audit §2.2, §3.6).
- [x] **T-shirt cumulative list** — derived view (`/api/tshirts`) over
      `TournamentEntry.t_shirt_size` across tournaments; **T-shirts** Setup tab
      (audit §8 F1).
- [x] **Player hotel stays** + **CVB sponsorship analytics** (migration 0014;
      `/api/hotel-analytics` totals per hotel) — audit §1.2.

**Done when:** every list in the vision can be filed from the review inbox and
exported. ✅ **Done** — all Phase-4 lists are built and each has a CSV export.
Remaining: the optional auto-triage agent.

---

## Phase 5 — Polish & hardening
- [ ] PII: encryption at rest, access control, retention policy (audit §5.1).
- [ ] Audit trail for money (store calc inputs + rule version — audit §5.3).
- [ ] Multi-user TD access if needed (D8).
- [x] **CSV export on every list** — a generic "⬇ CSV" button on the roster,
      t-shirts, inbox, and all Part B list tables (skips the actions column), plus
      the officials report's existing Print + CSV. (PDF still optional.)
- [ ] Correction handling: follow-up emails that amend an earlier row.

---

## Dependency map
```
Phase 0 ─┬─→ Phase 1 ──→ Phase 2          (Officials track — ship independently)
         └─→ Phase 3 ──→ Phase 4 ──→ Phase 5
                         (Player track = email forwarding + human review)
```
Part A (Phases 1–2) and Part B (Phases 3–4) can proceed in **parallel** after
Phase 0 if there's capacity, since they only share the core schema. No agent/LLM
is in scope; an automated triage agent is a possible follow-on after Phase 5.

---

## Suggested first step
All decisions are made — pick the web stack and execute Phase 0 + the
read-only/CRUD slice of Phase 1. That produces a usable officials tool fastest;
the human-review Part B (Phase 3) can follow in parallel.

---

## UI review & backlog (2026-05-24)
Critical review of the running POC UI. Ordered by impact.

### 🔴 Missing — needed to finish Phase 1
- **✅ DONE — Reports**: officials confirmation & pay report with per-day roles,
  site/hotel, **dietary** column, pay/mileage **totals**, missing-distance and
  hotel-date-mismatch flags, plus **Print** and **Export CSV**
  (`/api/tournaments/{id}/reports/officials`, Reports tab).
- **✅ DONE — Roster CSV/XLSX import** (audit §3.8): `POST .../players/import`
  upserts players by USTA ID + entries, with tolerant header matching; UI file
  picker on the Roster tab.
- **✅ DONE — `OfficialSiteDistance` workbook backfill** (audit §3.7):
  `backfill_distances.py` imports officials + distances from
  `Officials Mileage Workbook.xlsx` (one-way = `(reimbursable+50)/2`), skipping the
  `182` placeholder. First run: 47 officials, 38 distances, 6 placeholders skipped.

### 🟡 Correctness / trust gaps
- **✅ DONE — Player history**: `player` stays current; append-only
  **`player_history`** (SCD Type 4, migration `0004`) maintained by a trigger;
  **point-in-time names** resolved for past-tournament rosters; Name-history UI in
  the Player detail. Per-tournament division already snapshotted on the roster.
  See [data-model.md](data-model.md) §PlayerHistory.
- **✅ DONE — Room-count enforced**: assigning an official to a full block returns
  **409**; `rooms_remaining` is shown in the room-block list + assignment dropdown.
- **Pay/mileage not snapshotted** (audit §5.3): only `AssignmentDay.rate_applied`
  is stored; mileage, total, and `rule_version` are recomputed on read. Store a
  snapshot at confirm time for reproducible money. **✅ DONE** — snapshots
  (`snapshot_pay/mileage/total`, `rule_version`, `snapshot_at`) frozen on every
  assignment change (migration `0005`); the report shows the pay-rule version.
- **✅ DONE — Assignment role constrained**: `working_as` must be a certification
  the official holds (409 otherwise), once any are on file (`Certification`).
- **✅ DONE — Assignment site constrained**: the Assignments mileage-`site`
  dropdown now lists **only the active tournament's sites** (filled per-tournament in
  `loadAssignments`, not from the global site list). Verified: a tournament with 1
  linked site shows 1 option (+ none), down from 4 global sites. *(Kept UI-side; the
  API still accepts any site so existing informational-mismatch behavior + tests are
  unchanged.)*
- **✅ DONE — Work-date bounds warning**: work days outside the play window are now
  **flagged** (a ⚠ marker on the day chip) and adding such a day triggers a
  **confirm** ("N day(s) fall outside the play window … Add anyway?") — a warning,
  not a block (consistent with audit §3.4). Verified: `_outOfWindow` is true before
  `play_start`/after `play_end`, false inside.

### 🟢 UX / polish
- **Inline mileage fix**: when an assignment shows "no distance", offer an inline
  "add distance" action instead of making the TD switch to the Distances tab.
- **Assignment card** is a dense run-on line → use a small structured layout
  (name; pay/mileage/total badges; flags as colored chips); label the add-day date
  field.
- **Two ways to pick a tournament** (Setup list "Work on this" + context-bar
  selector) — keep, but make the Setup-list row offer "Work on" directly.
- **Naming consistency**: Setup forms say *New/Create/Save*; workspace sub-forms say
  *Add/Clear* — unify.
- **Feedback**: success/error messages auto-clear in 4s and can be missed; consider
  a persistent toast for errors. No loading indicators.
- **Required-field affordance** and clearer validation styling on inputs.
- **Accessibility**: tabs are plain buttons (no `role="tablist"`/arrow-key nav);
  add ARIA + keyboard support. Status colors already pair with text (good).
- **Mobile**: the two-group menu wraps to several rows; consider a compact/scrolling
  nav. (master-detail already stacks.)
- **Server-side filtering/pagination** once lists grow (filters are client-side).

### Notes
- These are captured from the UI as built; they do **not** change earlier
  decisions. Items marked 🔭 in [data-model.md](data-model.md) (Certification,
  Availability, all of Part B) remain future work by design.

---

## TD review round 2 (2026-05-24) — applied
- **✅ 5 certification types** (migration `0009`): roving official, chair umpire,
  tournament referee, deputy referee, referee in training — across rates, certs,
  assignment roles, and every dropdown.
- **✅ Assignment day flow**: selecting an official shows their **available days**
  (select-all / individual) + a certification dropdown to add days; a manual date
  is the fallback when no availability is on file.
- **✅ Report grouped by Official → certification → days**, and **weekday added** to
  dates on the Report and Availability views.
- **✅ Certification checkboxes on the Availability tab** (set an official's held
  certs inline).
- **✅ "Hotel assignment"** label on Assignments (was "Room block").
- **✅ Distance delete verified** (returns 204; earlier failure not reproducible).

### ✅ DONE — hotel model reframe (migration 0010)
The TD clarified two distinct hotel needs the single `room_block` conflated; now
split by **`kind`**:
1. **`player`** — discounted hotel rates offered to *players*.
2. **`official`** — comp rooms for *officials* needing accommodation.

Implemented: `kind` on `room_block`; Room blocks tab has a **Block type** selector
+ column; `GET /room-blocks?kind=` filter; the Assignments **Hotel assignment**
dropdown lists **only `official` blocks**; the Reports tab has an
**officials-needing-accommodation roster** (official + hotel + night span).

---

## UI/UX pass 1 (2026-05-25) — applied
First batch from the UI review (frontend only; backend/tests unchanged):
- **✅ Grouped tournament nav** — the 14 tournament tabs are split into labeled
  sub-areas: **Tournament** (Sites/Roster/Availability), **Staffing**
  (Assignments/Room blocks/Reports), **Player requests** (Inbox + the 7 lists).
- **✅ Status color chips** — `selection_status`, email `status`, doubles type, etc.
  render as tinted badges (ok/warn/bad/info/muted) for scannability.
- **✅ Toasts** — every `setMsg` also raises a corner toast (errors linger longer);
  inline messages kept.
- **✅ Accessibility** — `:focus-visible` outlines; the menu is a `role="tablist"`
  with `aria-selected` and **arrow-key** navigation.
- **✅ Table polish** — zebra striping + **sticky headers** on list tables.

## UI/UX pass 2 (2026-05-25) — applied
- **✅ Global loading bar** — a thin top progress bar driven by the `api()` wrapper
  (shows whenever any request is in flight).
- **✅ Right-aligned numeric columns** — report pay/mileage/total, rate/day,
  one-way miles, room counts.
- **✅ Button consistency** — the previously unstyled save buttons (availability,
  my-availability) now match the primary button; report Print/CSV already matched.

## UI/UX pass 3 (2026-05-25) — applied
- **✅ Styled delete confirm** — a real modal (`confirmDialog()`, Esc/Enter
  support) replaces the browser's native `confirm()` across all 11 delete actions.
- **✅ Busy-on-submit** — the Setup forms disable their submit button while saving
  (prevents double-submit; complements the global loading bar).

## UI/UX pass 4 (2026-05-25) — applied
- **✅ Collapsible add-forms** — the 9 workspace add-forms are wrapped (at runtime,
  no HTML churn) in `<details>` and **closed by default** so the list is primary;
  they **auto-open** when filing-from-email or editing a row.
- **✅ Busy-on-submit extended** to the workspace `wirePlayerList` forms
  (scheduling/division/player-hotels) on top of the Setup forms.

## UI/UX pass 5 (2026-05-25) — applied
- **✅ Fixed master-detail proportions (bug)** — the grid had the **list capped at
  360px** (`minmax(260px,360px) 1fr`), forcing long columns (e.g. site/hotel
  names) to wrap to many lines. Flipped to `minmax(0,1fr) minmax(280px,380px)` so
  the **list gets the room** and the form is bounded; raised the stacking
  breakpoint to **980px** so medium screens get a **full-width list** instead of a
  cramped two-column; page max-width 1100→1200; the edit form is **sticky** while
  scrolling a long list. Verified: a 1421px viewport gives a 752px list with the
  long names on a single 36px row.

## UI/UX pass 6 (2026-05-25) — applied
- **✅ Compact forms** — denser detail/add forms per request: small **uppercase
  field labels** (0.68rem), smaller controls (0.82rem, tighter padding), reduced
  row spacing, and **compact buttons** (submit/delete/cancel/new/save at 0.8rem).
  Forms take far less vertical space while staying readable.

## UI/UX pass 7 (2026-05-25) — applied
- **✅ Condensed toolbar** — the whole top chrome was slimmed to reclaim vertical
  space: **header** padding 1rem→0.5rem and the **h1** 1.4rem→1.05rem; the
  **context bar** is tighter (padding 0.4→0.25rem, gap 0.5→0.4rem, font 0.85→
  0.72rem) with a smaller **active-tournament select** (min-width 240→200px,
  0.78rem); the **nav menu** is denser (gap 1.5→1rem, 2px under-border) with
  smaller **tabs** (0.92→0.82rem, padding 0.55/0.85→0.38/0.7rem) and **group
  labels** (0.7→0.6rem); **user box / logout** dropped to 0.72rem. Verified in
  preview: h1 16.8px, tabs 13.12px, context-bar 4px/8.8px padding, no console
  errors.

## UI/UX pass 8 (2026-05-25) — applied
- **✅ Lists own their scrollbar** (native, dependency-free per D6) — each Setup
  master-detail list now lives in a `.list-scroll` container with its **own
  vertical scrollbar** (`max-height: calc(100vh - 200px)`, sticky header pinned to
  the container edge). The list no longer pushes the page tall, so the sticky edit
  form stays in view — no more scrolling **past** the form to reach items at the
  bottom. *(We kept the pure-HTML/CSS approach rather than adopting a third-party
  grid like Tabulator/AG Grid, on the user's call — same "grid with its own
  scrollbar" UX, no CDN dependency, works offline.)*
- **✅ Prev / Next record navigation** — every master-detail detail form gets a
  small nav bar (`‹ Prev` · `N / total` · `Next ›`) that steps through the
  **currently filtered** list without touching the list at all; endpoints disable
  at the ends, the position counter reflects the active filter, and the selected
  row auto-scrolls into view inside its container. Verified in preview: 7 scroll
  containers + 7 nav bars, `1 / 2`→`2 / 2` stepping, Prev disabled on the first
  record, no console errors.

## UI/UX pass 9 (2026-05-25) — applied
- **✅ List height bounded to the viewport (dynamic)** — the earlier
  `calc(100vh - 200px)` was a guess and could still run a long list off the bottom
  of the screen. Now a tiny `sizeLists()` helper measures each active
  `.list-scroll`'s real top offset and sets a `--list-max` CSS variable to the
  exact space remaining (`innerHeight − top − 16px`), recomputed on **tab switch,
  window resize, and load**. The list's own scrollbar now always ends inside the
  viewport regardless of toolbar height. Verified: list top 212px → `--list-max`
  1051px → list bottom within the 1279px viewport.
- **✅ Toolbar condensed further** — second density pass: header padding 0.5→0.3rem
  and h1 1.05→0.92rem (14.7px); context bar padding 0.25→0.18rem, labels 0.72→
  0.68rem, active-tournament select 0.78→0.74rem (min-width 200→180); nav tabs
  0.82→0.78rem (12.5px) with tighter padding (0.38/0.7→0.28/0.6rem) and group
  labels 0.6→0.55rem.

## UI/UX pass 10 (2026-05-25) — applied
- **✅ Two-level menu** — the toolbar no longer shows every tab at once. A
  **level-1 bar** lists the four sections (**Setup · Tournament · Staffing ·
  Player requests**); picking one reveals **only that group's tabs** in the
  level-2 bar (`.menu-group.group-active`), auto-opening its first enabled tab.
  Cross-group jumps (e.g. file-from-email) keep the level-1 highlight in sync.
  Verified: 4 group buttons, exactly one group's tabs visible, Staffing→Assignments
  opens correctly.
- **✅ Type-in dropdowns (searchable comboboxes)** — every native `<select>` is
  progressively enhanced into a **filter-as-you-type** dropdown (`enhanceSelect`):
  a text input overlays the select, typing filters options, ↑/↓/Enter/Esc work,
  and click-away closes. The native `<select>` stays the **source of truth**
  (value/`required`/submit/listeners unchanged), with displays re-synced on
  change / option-repopulation (MutationObserver) / form reset / edit-fill /
  active-tournament restore. Stayed **dependency-free** (no Select2/Choices.js).
  Verified: 17 comboboxes; the officials picker filters 51→5 on "z" and writes the
  chosen value back to the select; no console errors.

## UI/UX pass 11 (2026-05-25) — applied
- **✅ Part B forms reference the existing Players list** — every Staffing /
  Player-request form now **picks an existing player** instead of free-typing a
  name + USTA #. The three free-text fields (USTA #, first, last) collapsed into a
  single **Player** picker (`select.player-ref`, a type-in combobox) on late
  entries, withdrawals, scheduling avoidances, division flexibility, player hotels,
  doubles (player **and** partner), and each **pairing-group member** row.
  (Staffing's Assignments already used an officials picker.) On submit the chosen
  player is resolved back to USTA #/first/last, so the **backend is unchanged**
  (it still upserts/matches by USTA #). The file-from-email flow focuses the new
  player picker. Verified end-to-end: filing a scheduling avoidance via the picker
  created the row against the active tournament for the referenced player; 9 player
  pickers populate (14 players + blank); no console errors.

## UI/UX pass 12 (2026-05-25) — applied
- **✅ Combobox placeholder fix** — the "— select … —" prompt was sitting in the
  input as a real value, so you had to delete it before typing a search. It's now
  rendered as the input's grey **`placeholder`** (the field starts empty), and the
  input **selects its text on focus** so an existing choice can be typed over too.
  Verified: an unset player picker shows empty value + "— select player —"
  placeholder, and typing "jon" filters straight to "Jones, Sam" with no clearing.

## UI/UX pass 13 (2026-05-25) — applied
- **✅ CSV template downloads** — next to each list's **⬇ CSV** export button there
  is now a **⬇ Template** button that downloads an **empty CSV with just the
  headers** for the user to fill in. **Roster's** template uses the importer's
  **canonical field names** (`usta_number, first_name, last_name, age_division,
  events, selection_status, t_shirt_size, dietary_preference`) so the filled file
  re-imports as-is; other lists use their visible column headers. Derived/aggregate
  lists (verified doubles pairs, CVB totals, inbox, cumulative t-shirts) are
  export-only and get no template. Verified: 8 template + 12 export buttons; roster
  template emits the canonical header row; no console errors.

## UI/UX pass 14 (2026-05-25) — applied
- **✅ Full-width layout** — dropped the centered **1200px cap** on `main` (which
  left large empty margins on wide screens) in favour of a **fluid full-window**
  layout with comfortable side padding (1.75rem). The reclaimed space goes to the
  **list** (1fr) and the **detail form** (cap nudged 380→420px). Verified at a
  1421px viewport: `main` 1421px, list pane 925px (was ~752px), form 420px; no
  console errors.
  - **Rebalanced** (follow-up): the lists were too wide and the form too narrow, so
    the detail column was widened to `minmax(420px, 600px)` — at 1421px the form is
    now 600px and the list 745px.

## UI/UX pass 15 (2026-05-25) — applied
- **✅ Combobox dropdown contrast fix (bug)** — dropdown items were **inheriting**
  their text colour from the surroundings: the header (active-tournament) combobox
  showed **white text on the white list** (invisible), and form comboboxes inherited
  the muted-grey label colour (low contrast). The `.combo-list`/`.combo-item` now
  set explicit `color: var(--ink)` on `#fff` (and reset inherited uppercase/letter-
  spacing), with highlighted/selected rows keeping dark ink on the light `--sel`
  green. Verified: item text is `rgb(31,41,51)` in both header and form dropdowns.

## UI/UX pass 16 (2026-05-25) — applied
- **✅ Placeholder no longer a dropdown row** — the blank "— select … —" / "— none —"
  option was appearing as a selectable item in the combobox list. It's now excluded
  from the rendered list (it already shows as the input's grey placeholder). Optional
  fields are still clearable: empty the text and commit (Enter / click-away) and the
  selection resets to none; required fields simply have no blank row. Verified:
  active-tournament shows only the 2 tournaments, an optional site picker shows only
  real sites yet still clears to none, and the required player picker lists only
  players — no "— … —" rows anywhere.

## UI/UX pass 17 (2026-05-25) — applied
- **✅ Roster import row tidied** — the oversized **Import CSV/XLSX** button is now a
  compact **Import** (0.8rem), and a **⬇ Template** button sits right beside the
  upload control (secondary `.ghost` style) so the importer's template is where you
  need it. The template emits the importer's **canonical columns**
  (`usta_number … dietary_preference`) — fill it in and re-upload. The redundant
  table-side roster template was removed (roster added to `NO_TEMPLATE`); the roster
  table keeps its **⬇ CSV** export. Verified: Import 12.8px/compact padding, template
  emits the canonical header row, only the CSV export remains by the table; no
  console errors.

## UI/UX pass 18 (2026-05-25) — applied (roadmap correctness gaps)
Reviewed the roadmap and executed the two outstanding **🟡 correctness gaps** that
need no external service:
- **✅ Assignment site constrained** to the active tournament's sites (dropdown
  filled per-tournament in `loadAssignments`). Verified: 1 linked site shown vs 4
  global.
- **✅ Work-date bounds warning** — ⚠ flag on out-of-window day chips + an
  "Add anyway?" confirm when adding a day outside the play window (warning, not a
  block — audit §3.4). Verified via `_outOfWindow`.

### Deferred — need an external service or an explicit decision (not executed)
These remaining roadmap items can't be completed inside the local POC without new
infrastructure or a privacy decision, so they're intentionally left open:
- **Google Maps geocoding** for auto-distance (Phase 2) — needs a Maps API key +
  network egress; **manual distance entry is the working fallback** today (D3/U2).
- **Dedicated forwarding-address email auto-ingest** (Phase 3, D4) — needs real
  mail infra; **manual add to the review inbox** is the working POC path.
- **LLM triage upgrade** (D5) — the local rule-based suggester ships; an LLM that
  reads minors' email content requires the **cloud-vs-local privacy call first**.
- **PII encryption at rest / retention** + **DB hardening** (Phase 5, audit §5) —
  tied to the post-POC deployment switch (dedicated DB user, secrets, TLS).
- **Money audit trail** beyond the current snapshot (store all calc *inputs*),
  **correction-handling** for amending emails, and **multi-user TD access** (D8) —
  lower-priority polish.

Still open from the UI review (no external dep, just not yet done): a full
button-style **utility-class system**, busy-on-submit on the remaining bespoke
forms (assignment/doubles/pairing), and a **sidebar nav** for very narrow screens.
