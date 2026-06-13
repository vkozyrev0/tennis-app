# CourtOps Tennis — Build Roadmap

A phased plan to go from the vision to a working system. Ordered so that each
phase delivers something usable on its own and de-risks the next. Cross-refs:
[vision-summary.md](vision-summary.md) · [audit.md](audit.md) ·
[data-model.md](data-model.md).

> **Status (2026-06-13):** Phases 0–4 are functionally shipped; Phase 5 is polish
> and deploy-time hardening (see *On hold* for the two externally-blocked items).
> The latest rounds — the **improvement plan** (P1 quick wins + P2 structural
> refactors), **day-of operations** (official actual status, player check-in,
> incident log, assignment change audit), and an **inbox detection wave**
> (doubles partners, pairing-avoidance groups, USTA-number extraction, manual
> player assignment) — are summarized in *Shipped 2026-06-10 → 06-12* below.
> Earlier, the **TD-review build-out** closed the remaining workflow gaps — a
> "Today" dashboard + cross-tournament digest, a pre-event **readiness
> scorecard**, coverage-gap → one-click fill, conflict / declined /
> missing-distance / no-login reports, bulk-invite + personalised invite text,
> inbox **triage** (classify → detect → populate) with aging + unmatched
> drilldowns, Player/Official 360 + exports, rooming list, day-by-day schedule,
> pay statements, dietary + workload rollups, and self-service availability.
> Full list in [changelog.md](changelog.md); end-to-end validation in
> [e2e-findings.md](e2e-findings.md). Suite: **460** green and deterministic;
> CI builds + publishes `ghcr.io/vkozyrev0/tennis-app:latest` on main pushes.

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
- [x] **Change own password** (`POST /api/auth/change-password`): any logged-in
      user (admin or official) verifies their current password and sets a new one
      (min 8 chars, must differ); other sessions are invalidated while the
      current one stays alive. Header "Change password" button → modal.
- [x] **Availability** — both **TD-side** (Availability tab, migration 0007) and
      **officials' own** (self-service).
- [x] TD sees availability when making assignments — the Assignments official
      picker shows each official's available-day count for the tournament, and the
      day picker offers their available dates.
- [x] **Bulk availability entry** — the Availability tab has quick-select
      controls (All days / None / Weekdays / Weekends, plus an additive
      from–to range) so the TD sets a season of dates in one action instead of
      day-by-day; the user still reviews then Saves (same PUT, frontend-only).
- [x] **Availability-vs-assigned gap** — the Availability table gained an
      "Assigned" column (✓ / ⚠ not yet) and a callout listing officials who
      offered dates but have no assigned day, so the TD staffs everyone who
      volunteered. Frontend-only (joins the tournament's availability +
      assignments client-side); verified live (gap callout correct).
- [x] **Unassigned-availability nudge** — the same gap surfaced on the
      Assignments panel (where staffing happens): a callout naming available
      officials with no assigned day + an "Open Availability →" jump link.
- [x] **Coverage gaps by day** — the officials report reports a per-day
      officials count (footer row aligned under the weekday columns, zero-days in
      red) + a callout listing tournament days with **no official assigned**, so
      the TD fills uncovered days before the event. On screen + in the PDF.
      (`coverage` / `uncovered_days` / `uncovered_days_count` in the report.)
- [x] **Per-site coverage by day** — a site×day grid (officials at each venue
      each day, zeros in red), finer than the tournament-wide counts. Rows include
      every linked site (a fully-uncovered venue still shows) + a "(no site)" row
      for venue-less assignments. On screen + in the PDF. (`site_coverage`.)
- [x] **Per-role coverage by day** — a role×day grid (officials working each role
      each day, same zero/thin highlighting), so the TD spots a day thin on a
      needed role (e.g. chairs Mon–Wed but none Thu), not just headcount. Rows are
      the roles used in assignments. Screen + PDF + CSV. (`role_coverage`.)
- [x] **Assignment day-count column** — the officials report gained a **Days**
      column (each official's total assigned days) + a grand total in the footer
      (`official_days_total`), so the TD sees per-official load at a glance.
      Screen + PDF + CSV.
- [x] **Certification pool report** — a matrix of every official × the certs they
      hold + a holder count per cert (zeros flagged), so the TD plans role
      coverage against the available pool. Global (not tournament-scoped). Screen
      + PDF. (`cert_pool` in the report.) The role-coverage grid ties to it: a ⚑
      marks a role/day undercovered while more certified officials are available,
      and officials holding **no certification** are flagged (can't be assigned
      any role) with a chase-the-paperwork note.
- [x] **Coverage in the CSV export** — the report CSV now appends an "Officials
      per day" row + a per-site row, aligned under the same day columns, so the
      TD can track/share coverage gaps in a spreadsheet.
- [x] **Thin-coverage threshold** — a "Min officials/day" control on the report:
      days/sites at zero stay red (hard gap), those below the minimum (but >0)
      are flagged amber, with a separate note line. Persisted in localStorage;
      re-renders from memory (no refetch); honored on screen + in the PDF.
- [x] **Availability mismatch check** — a worked day the official did **not**
      declare available is flagged (never blocked): a per-day ⚠, a "not available"
      chip on the assignment card, and an availability count in the report totals.
      Suppressed when the official declared nothing. (`days_outside_availability`
      / `has_availability_data` in the assignment summary.)
- [x] **Per-day certification guard** — the assign path already hard-blocks an
      uncertified role (409); the report/card now also **flag** a day that became
      uncertified after the fact (cert revoked post-assignment): per-day ⚠, a
      "not certified" card chip, `uncertified_count` in report totals. The
      add-day form blocks early with a friendly message + held-cert pre-check
      (`held_certs` / `uncertified_days` in the summary).
- [x] **Officials accept/decline** (migration 0038, benchmark gap): the official
      accepts/declines the assignment the TD made from their self-service "My
      assignments" view (`GET/POST /api/me/assignments...`); the
      `response_status` (pending/accepted/declined) shows as a chip on the TD's
      assignment card.
- [x] **Decline visibility for the TD** — the Assignments panel has a
      response-status summary + filter chips (All / Pending / Accepted /
      Declined, declines sorted first) so the TD jumps straight to what needs
      re-staffing; the report totals carry `declined_count` / `pending_count`
      and the roster flags a DECLINED official inline (table + PDF).
- [x] **Chase pending responders** — the assignment summary carries the
      official's email/phone; the response bar offers a one-click "✉ Email N
      pending" mailto (BCCs all non-responders) and each pending card shows an
      "awaiting response" contact line with mailto/tel links.
- [x] **Status + flags in "My assignments"** — the official's self-service view
      shows a "Please accept or decline" prompt while pending, their pay/mileage,
      and a plain-language heads-up for any day scheduled outside their declared
      availability, on an uncertified role, or double-booked — so they can
      decline or contact the TD informedly.
- [x] **Reassign from a declined slot** — a "Reassign" button on a declined
      assignment card pre-fills the add-form with the same site/hotel (official
      cleared) and copies the declined days onto the replacement on save; the
      declined assignment is kept as an audit trail. Frontend-only (composes the
      existing create + add-day endpoints); verified live end-to-end.
- [x] **Per-official season pay** — a pay/mileage summary across ALL the
      official's tournaments (per-tournament breakdown + season totals):
      `GET /api/officials/{id}/pay-summary` (TD) and `/api/me/pay-summary`
      (the official's own, in a self-service "My pay" view).
- [~] **Google Maps geocoding** to auto-compute home↔site round-trip distance
      (the primary mileage source), with **manual entry as fallback** when the
      lookup is unavailable (D3/U2). **Scaffolded** behind `GOOGLE_MAPS_API_KEY`
      (migration 0047, source `maps`), **blocked on the API key + egress**; the
      key-free great-circle estimate remains the fallback.

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
- [x] **Audit trail for money** (migration 0036, audit §5.3): the snapshot now
      also freezes the calc **inputs** in `assignment.pay_audit` (jsonb) — the
      one-way miles used, the rule constants (free-miles / rate / cap), and the
      per-day rates — alongside the outputs + rule version, so a reimbursement is
      reproducible even after a distance/rate changes. Surfaced as an ⓘ tooltip
      on the assignment card's total badge.
- [ ] Multi-user TD access if needed (D8).
- [x] **CSV export on every list** — a generic "⬇ CSV" button on the roster,
      t-shirts, inbox, and all Part B list tables (skips the actions column), plus
      the officials report's existing Print + CSV, and a **PDF export** (a clean,
      self-contained landscape report — officials day-grid + lodging + other
      staff — opened in a print window to save as PDF; no PDF lib).
- [x] **Correction handling** (migration 0034): a follow-up email can be marked
      as amending an earlier one (`email_message.amends_email_id`,
      `POST /api/emails/{id}/amends`). The inbox shows **↻ correction** /
      **⤺ superseded** badges and a "Corrects earlier email" picker in the
      Review modal. **Auto-rewrite** (`POST /api/emails/{id}/apply-correction` +
      an "Apply correction" inbox action): filing a correction **updates the
      amended email's filed row in place** (re-points `source_email_id` +
      re-applies the parsed fields) instead of creating a duplicate, for the
      bulk-fileable lists (late entry / withdrawal / scheduling / div-flex /
      hotel).

---

## ⏸️ On hold — deferred (external dependency or explicit decision required)
These are intentionally **parked**: each needs a third-party service, real
infrastructure, or a privacy decision the POC cannot make on its own. Everything
buildable without them is done; revisit when the prerequisite is available.

| Item | Why it's blocked | To unblock |
|------|------------------|------------|
| **Google Maps auto-distance** (driving home↔site round-trip) — Phase 2 / D3/U2 | Needs a billed Maps API key + network egress for *driving* distance. **Partly shipped:** a key-free **great-circle estimate** from stored lat/long now exists (`app/geocode.py`, `POST /api/distances/auto`, source=`geocoded`), and the **driving-distance Distance Matrix call is now scaffolded** (migration 0047, `road_one_way_miles()` behind `GOOGLE_MAPS_API_KEY`, source=`maps`) — still **key-blocked**. | Provide an API key + confirm cost + egress; the driving-distance path is wired (the estimate stays the fallback). |
| **Real email auto-ingest** (forwarding address) — Phase 3 / D4 | Needs a mail domain + inbound webhook/IMAP infra. POC uses manual paste into the review inbox. | Stand up a forwarding address + ingestion endpoint; dedup by `message_id` already exists. |
| **LLM triage upgrade** (reads email content) — D5 | Open **cloud-vs-local privacy** call for minors' PII; current suggester is a local keyword heuristic (no data leaves the building). | Make the D5 decision; if approved, swap `triage.py` for an LLM behind the same `/suggest` API. |
| **PII-at-rest encryption + DB hardening** — Phase 5 / audit §5.1, §5.3 | Needs a non-localhost deploy target, a secrets store, and a least-privilege DB role/TLS for the *encryption* piece. **Partly shipped** (see `docs/pii-hardening-plan.md`): **H1** ENV-gated boot guard refusing default creds / non-TLS in prod + `sslmode`; **H3** PII erased from `player_history` on delete + an email-body retention-purge endpoint. | At deploy time: dedicated DB user + secret from env, TLS, column/disk encryption (H2), retention schedule + purge job (H3.1/H3.3). |
| ~~**Non-official staff in the Staffing Plan**~~ — ✅ **SHIPPED** (migration 0032): a per-tournament `tournament_staff` roster (name + `staff_role` ∈ Site Director / Player Amenities / Trainer / Operations / Stringer / Other + contact), a **Staffing → Staff** tab (CRUD), and an **"Other staff"** section in the officials report (+ `staff_count`). Per-day staff scheduling now ships (staff_day, day-column report grid); flat daily-rate pay now ships (report totals staff pay); per-day-varying rates remain a possible refinement. |

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
- **✅ DONE — Room-block pickup report**: the officials report shows, per official
  comp block, rooms **reserved vs assigned (pickup)** and **unused**, with a
  tournament roll-up + a warning when rooms are unassigned — so the TD releases
  surplus before the hotel cutoff (attrition). On screen + in the PDF.
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
- **✅ DONE — Inline mileage fix**: assignment cards with `missing_distance` show
  an inline "No mileage on file — [one-way miles] add distance" action that POSTs
  `/api/distances` (source=`manual`) and reloads, no trip to the Distances tab.
- **✅ DONE — Assignment card**: structured layout — header with actions menu,
  pay/mileage/total badges, per-day chips with ⚠ flags (out-of-window,
  double-booked, outside-availability, uncertified).
- **✅ DONE — Setup-list "Work on" action** (audit M33): each tournament row has
  an "Open ▸" rowAction that sets the active tournament and jumps into its
  workspace directly.
- **✅ DONE — Naming consistency**: every CRUD form submit is **Save** (the
  modal triggers are "＋ Add …"); only auth flows keep specific labels
  (Sign in / Add admin / Update password).
- **✅ DONE — Feedback**: error toasts persist with a close button (WCAG 2.2.1);
  success toasts auto-fade; top progress bar shows in-flight requests; server
  errors flag the responsible input (aria-invalid + focus).
- **✅ DONE — Required-field affordance**: `.req` markers + `:user-invalid`
  styling (red border/tint only after interaction, incl. combo inputs).
- **✅ DONE — Accessibility (tabs)**: `.menu-group`s are `role="tablist"`, tabs get
  `role="tab"`/`aria-selected`/`aria-controls`, roving tabindex, and
  ArrowLeft/Right/Home/End with automatic activation.
- **✅ DONE — Mobile nav**: at the narrow breakpoint the two menu bars become a
  single-row horizontally-scrolling strip (`overflow-x: auto; flex-wrap: nowrap`).
- **✅ DONE — Server-side filtering/pagination (inbox + players)**: `GET
  /api/emails` AND `GET /api/players` take `q` (SQL `ILIKE` on plaintext
  metadata only — encrypted PII isn't searched), `limit`/`offset`, and return
  `X-Total-Count`. The inbox loads a capped page with a debounced server search;
  the Players grid does the same via `wireEntity`'s opt-in `serverSearch` mode
  (capped at 500 + "refine" note), with the picker cache (`playersById`) guarded
  against search-narrowed loads so roster/Part-B pickers keep the full roster.
  Other big lists can now opt in one line at a time.

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
The dated, per-change record lives in **[changelog.md](changelog.md)**. At a
glance, themes delivered through 2026-05-27:
- **Navigation / density** — two-level section menu; the workspace tabs split
  into 5 groups (Setup, Tournament, Staffing, Player requests, Player
  preferences); condensed toolbar; full-width layout; ARIA tab semantics.
- **Lists / inputs** — viewport-bounded scrollers + Prev/Next nav; type-in
  comboboxes; required-field affordance; segmented control on Roster
  (Pick existing | + New player); 9-type staged importer registry + a
  parametrized round-trip test for every type.
- **Data + IO** — CSV export with `exportCols` so every list round-trips
  through its matching importer; t-shirt inventory + order snapshot;
  Setup-page CSV templates auto-generated from the registry.
- **Schema additions** (migrations 0017–0027) — `player.gender` required;
  `player.city`/`state`; lodging plan; `hotel_id` FK on player hotels;
  configurable `division` + `tournament_event` catalogs; `tshirt_order`
  per-tournament snapshot; `import_batch` / `import_row` staging tables.
- **Robustness / accessibility** — busy-on-submit; toasts; confirm modal;
  focus-trap modals via `inert`; UTC date arithmetic everywhere;
  optimistic concurrency on `/api/players` PUT (`X-If-Updated-At`);
  global `[hidden] { display: none !important }` so `el.hidden` actually
  hides on `display: flex` elements.
- **Correctness / security** — tournament-scoped assignment site;
  off-window-day flags; session expiry + rotation on login + GC of the
  rate-limit dict; `samesite=strict` + `secure` cookie; per-route
  cross-account username guard on the official-account PUT; hotel
  analytics counts stays per `(player, tournament)` for the CVB number;
  pairing-avoidance validates all members up front then commits as a unit.

## Shipped — recent rounds
Granular shipped detail lives in [changelog.md](changelog.md). Recent: payroll
finalization + CSV export, inbox Player 1/2 cells, soft-delete + Trash, the Maps
driving-distance scaffold, the auth/state/player_list extractions, and the
html`` helper sweep. The improvement-plan item-by-item record is in
[improvement-plan.md](improvement-plan.md).

## Open work (as of 2026-06-13)
- **Google Maps *driving* distance** (Phase 2) — ⚙️ **scaffolded** (2026-06-13):
  `road_one_way_miles()` calls the Distance Matrix API behind
  `GOOGLE_MAPS_API_KEY` (source `maps`) and `/distances/auto` stamps it; still
  **blocked on the key + egress + cost approval**, so the great-circle estimate
  (source `geocoded`) + manual entry + workbook backfill remain the live path.
- **Dedicated forwarding-address auto-ingest** (D4) — needs mail infra;
  manual paste into the review inbox is the working POC path.
- **LLM triage upgrade** (D5) — local rule-based suggester ships; an LLM
  that reads minors' email content requires the **cloud-vs-local privacy
  call first**.
- **PII H2 (encryption at rest)** + **least-priv DB role** + **scheduler wiring**
  for the retention sweep — tied to the post-POC deployment switch (see
  `docs/pii-hardening-plan.md` and the key-management/rotation design in
  `docs/pii-h2-key-management.md`). *(H3 retention **policy + sweep job** with
  dry-run now ship — `GET /api/retention/policy`, `POST /api/retention/sweep`.)*
- ~~**Payroll CSV batch export**~~ — ✅ **shipped** (2026-06-13):
  `GET /tournaments/{id}/payroll/export.csv` + an Export CSV button on the
  Payroll tab. P4-4 is now complete end to end.
- **Multi-user TD access** (D8) — ✅ **shipped**: admin user management (create/list/reset-password/delete with self + last-admin guards) at `/api/admin/users` + a Setup → Users tab.
- **Lower-priority polish** — utility-class system for buttons (cosmetic
  refactor); structured assignment-card layout. *(Inline "add distance" on the
  assignments tab is done.)*

## Backlog (2026-05-28 questionnaire — decisions locked in)

### B1. Division ↔ site assignment + t-shirt-by-location report
Multi-site tournaments need to know which division is at which site so the
TD can hand each site coordinator a t-shirt count sheet.

- **Scope:** per tournament (each year picks its own assignment).
- **Cardinality:** one division → one site (not split).
- **UI:** **Tournament → Sites** panel — toggle divisions per site.
- **Schema:** new `tournament_site_division (tournament_id, site_id,
  division_id)` join row, **OR** add `site_id FK NULL` to the existing
  per-tournament division-config row if one exists. Pick the lighter one.
- **Report:** single table with a Site column + group/filter (existing
  cumulative T-shirt grid pattern). Unassigned divisions → "Unassigned"
  bucket (do not block the report).

### B2. Roster — two import flavors
Replace today's single "Roster" importer with **Initial** + **Correction**,
sourced from the real spreadsheets the TD receives.

#### B2a. Initial — "Tournament Full Player Data" (xlsx)
Real columns from the June 2026 sample (24 cols, names verbatim):
`First name, Last name, Gender, ID, WTN Singles, WTN Singles Confidence,
WTN Doubles, WTN Doubles Confidence, Events, Selection, Payment status,
Amount paid ($), Amount refunded ($), Total amount due ($),
Amount outstanding ($), Card stored, Emails, Phone numbers, Answers,
Year of birth, City, District, Section, State`.

Behavior:
- Upsert **Setup → Players** on USTA #: insert new + update existing
  (name, gender, city, state, district, section, emails, phones, WTN).
- Upsert **Roster row** for the active tournament: overwrite division,
  events, status (parsed from `Selection`), payment fields.
- `Year of birth` (YYYY) → store as `birthdate = YYYY-01-01` with a
  `birthdate_precision = 'year'` column so we don't lie about full DOB.
- `Selection` is comma-separated keywords ("SELECTED", "ALTERNATE",
  "PRE_SELECTED", etc.) — derive `selection_status` (`selected` wins
  over `alternate`; `alternate` wins over nothing).

**Schema extensions** (new migration; columns NULLable):
- `player`: + `emails TEXT`, `phones TEXT`, `district TEXT`,
  `section TEXT`, `wtn_singles NUMERIC(4,2)`, `wtn_singles_conf TEXT`,
  `wtn_doubles NUMERIC(4,2)`, `wtn_doubles_conf TEXT`,
  `birthdate_precision TEXT CHECK IN ('day','year') DEFAULT 'day'`.
- `roster`: + `payment_status TEXT`, `amount_paid NUMERIC(8,2)`,
  `amount_refunded NUMERIC(8,2)`, `amount_due NUMERIC(8,2)`,
  `amount_outstanding NUMERIC(8,2)`, `card_stored BOOL`.

#### B2b. Correction — "Updated Status" (csv)
Real columns (13): `Name, First Name, Last Name, Gender, Events, City,
State, Tournament sign in, Draw status, Suspension points, USTA ID,
WTN Singles, WTN Doubles`.

Behavior:
- USTA # not on roster → late-add (insert).
- Roster rows **not** mentioned → leave alone.
- Updates: `selection_status` (parsed from `Draw status` — comma-separated
  keywords like "Alternate", "Withdrawn, Alternate" → withdrawn wins),
  `age_division`, `events`, `signed_in BOOL` (from `Tournament sign in`),
  `suspension_points INT` (NULLable), `wtn_singles`/`wtn_doubles`.

**Schema:** add `roster.signed_in BOOL DEFAULT false`,
`roster.suspension_points INT NULL` (or move suspension to `player`
if it's player-wide rather than per-tournament — needs TD confirm).

#### B2c. UX placement
- Two **separate sections** on the Import page (`#import-roster_initial`
  and `#import-roster_correction`).
- Both **also surfaced** on the Tournament → Roster toolbar via the
  existing `⬆ Import…` deep-link pattern.

### B3. T-shirts page — combined T-shirt + Hotel + Dietary import
Real columns from the sample (6): `Name, UAID, Tournament Name,
Preferred T-shirt Size, Are you planning to stay overnight in a hotel?,
Dietary Restrictions (Level 2, Level 3, or Level 4)`.

Behavior:
- USTA # (= `UAID`) not on roster → late-add to roster.
- Update **only non-empty cells** (blanks don't overwrite).
- `Hotel question` answers (free-text yes/no/local) map to existing
  `lodging_plan` enum: "No, I am local" → `Local / family`,
  "Yes, I plan to reserve…" → `Hotel`. Strict-match table at the
  importer; unknown → keep raw string in a new `lodging_plan_raw` column
  for TD review.
- `Dietary Restrictions` → straight into `dietary_preference` (free text).

**Replaces** the three per-tab imports (roster t-shirt size, player
hotels, dietary) — those go away in favor of this one.
**Page:** Tournament → T-shirts (per-tournament inventory + order).

**Schema:** + `roster.lodging_plan_raw TEXT NULL` for un-mappable
free-text answers; no other changes needed.

---

**Dependencies:** B2 + B3 both touch the `roster` table, so cluster them
in one migration (likely 0028). B1's join table is independent.

**Test files** for fixtures: live in repo root —
`Tournament Full Player Data (June 2026).xlsx`,
`Tournament Player's Updated Status … (June 2026).csv`,
`Tournament Players T-shirt-Hotel-Dietary (June 2026).csv`.
