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
the full smoke suite (**34 end-to-end tests**) passes; the server serves the API +
HTML page and creates sites/tournaments end-to-end.

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

## ⏸️ On hold — deferred (external dependency or explicit decision required)
These are intentionally **parked**: each needs a third-party service, real
infrastructure, or a privacy decision the POC cannot make on its own. Everything
buildable without them is done; revisit when the prerequisite is available.

| Item | Why it's blocked | To unblock |
|------|------------------|------------|
| **Google Maps auto-distance** (geocoding home↔site round-trip) — Phase 2 / D3/U2 | Needs a billed Maps API key + network egress; manual entry already covers the need. | Provide an API key + confirm cost; add a geocode call with manual entry as fallback. |
| **Real email auto-ingest** (forwarding address) — Phase 3 / D4 | Needs a mail domain + inbound webhook/IMAP infra. POC uses manual paste into the review inbox. | Stand up a forwarding address + ingestion endpoint; dedup by `message_id` already exists. |
| **LLM triage upgrade** (reads email content) — D5 | Open **cloud-vs-local privacy** call for minors' PII; current suggester is a local keyword heuristic (no data leaves the building). | Make the D5 decision; if approved, swap `triage.py` for an LLM behind the same `/suggest` API. |
| **PII-at-rest encryption + DB hardening** — Phase 5 / audit §5.1, §5.3 | Needs a non-localhost deploy target, a secrets store, and a least-privilege DB role/TLS. | At deploy time: dedicated DB user + secret from env, TLS, column/disk encryption, retention policy. |
| **Non-official staff in the Staffing Plan** (Site Director, Player Amenities, Trainer, Operations, Stringer) | Not a blocker — a deliberate scope choice; the model currently covers **officials** only, so the staffing-plan report shows officials. | Add a staff/role model (or extend assignment with a non-cert role + per-day availability/pay) and group them in the report like the TD's sheet. *(Deferred at the TD's request.)* |

> Session expiry/invalidation (migration `0017`) and admin/official access control
> are **done** — they're the parts of hardening that don't need new infrastructure.

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

## What's been built since this plan was written
The dated, per-change record (19 UI/UX passes, the code+docs audit follow-ups, and
post-audit improvements) lives in **[changelog.md](changelog.md)** — this plan file
stays forward-looking. At a glance, delivered themes:
- **Navigation / density** — two-level section menu; condensed toolbar; full-width layout.
- **Lists / inputs** — viewport-bounded scrollers + Prev/Next nav; type-in comboboxes;
  required-field affordance; Part B forms reference the existing Players list.
- **Data** — CSV export + fill-in templates; t-shirt order-quantity totals.
- **Robustness** — busy-on-submit; toasts; confirm modal; ARIA + `:focus-visible`.
- **Correctness / security** — tournament-scoped assignment site; off-window-day flags;
  session expiry + reset-invalidation; report N+1 removed; assorted validation fixes.
