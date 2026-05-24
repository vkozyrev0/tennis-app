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

## Phase 0 — Foundations  *(prereq for everything)*
- [ ] **All decisions D1–D8 are made** ([audit.md](audit.md) §7) — no open items.
      D5 resolved: **no automated parsing; email is human-reviewed** (the agent is
      a future enhancement).
- [ ] Scaffold the POC stack (D6): **Postgres** on localhost (default admin creds
      for now), a **Python API server** (FastAPI/Flask), and **pure HTML/CSS**
      pages that call it. Set up DB migrations + a test harness.
- [ ] Implement core schema: `Tournament` (with `registration_deadline`,
      `late_entry_deadline`, `play_start_date`/`play_end_date` — audit §2.5),
      `Site`, `Player`, `TournamentEntry` (TD roster), `Official`.
- [ ] Seed/fixtures + a smoke test.

**Done when:** schema migrates cleanly and a tournament + site can be created.

---

## Phase 1 — Officials app, administrator side  *(highest, clearest value)*
- [ ] TD CRUD: tournaments (name, type, the three dates above + match-play
      window, site), sites.
- [ ] **Per-tournament roster import** (`TournamentEntry`): TD supplies players by
      USTA ID with selection status, t-shirt size, dietary preference (audit §4.1).
      Default ingestion = **CSV/XLSX upload** mapped to `TournamentEntry`, plus
      manual add/edit for late entries; confirm the USTA export format (audit §3.8).
      Foundation for the alternate list, t-shirt history, and Part B lists.
- [ ] `CertificationRate` management (**per-day rate per certification** — D2).
- [ ] `HotelRoomBlock` inventory with `room_count`.
- [ ] Official records (created by TD initially; self-service in Phase 2).
- [ ] **Assignment** flow: confirm official for a tournament + hotel, with a
      **per-day role** (`AssignmentDay`) so the position can change day-to-day
      (audit §3.2). Room-count is a hard guard; **hotel date mismatches surface as
      a report alert**, not a block (audit §3.4).
- [ ] **Pay & mileage calc**: pay = Σ per-day rate for the role worked each day
      (audit §3.2); mileage = `clamp((miles−50)×0.65, 0, 100)` where `miles` =
      round-trip total and the $100 cap is a **hard ceiling** (D1/§3.1). Manual
      entry first; **Google Maps
      geocoding is the intended primary** with manual as fallback — added in Phase 2 (D3/U2).
      **Block pay computation on a missing address / unverified placeholder distance (audit §3.7 S4).**
- [ ] **Seed/backfill the `OfficialSiteDistance` matrix** from the existing
      `Officials Mileage Workbook.xlsx` where trustworthy, and surface officials
      missing a distance. Sample reality: 18/47 had no distance, and a `182`
      placeholder (`=(2*116)−50`) was reused across 6 officials — **import real
      values only, never placeholders** (audit §3.7 S4/S6).
- [ ] **Reports**: confirmation roster (by tournament/date/site/hotel) including a
      **dietary restrictions** column (audit §2.3) and a **hotel date-mismatch
      alert** where needed check-in/out falls outside the reservation (audit §3.4);
      plus pay/mileage totals (per official, per tournament).

**Done when:** TD can staff a tournament end-to-end and print both reports.

---

## Phase 2 — Officials self-service + auto-distance
- [ ] Official auth + "end-user platform": edit own profile, set per-tournament
      **availability** + `hotel_needed`.
- [ ] TD sees availability when making assignments.
- [ ] **Google Maps geocoding** to auto-compute home↔site round-trip distance
      (the primary mileage source), with **manual entry as fallback** when the
      lookup is unavailable (D3/U2).

**Done when:** officials self-declare availability and TD assigns from it.

---

## Phase 3 — Email ingestion + human review (Part B core)
The player side starts as a **human-review workflow — no automated parsing**
(D5/§5.1). The TD forwards player/parent email to a dedicated address; it lands in
a review inbox; a person files each message into the right list.
- [ ] Implement ingestion via the **dedicated forwarding address** (D4; smallest
      privacy blast radius — audit §5.2).
- [ ] `EmailMessage` provenance + dedup by `message_id`.
- [ ] **Review inbox UI**: show each message; the TD/staff pick its type and
      key the fields into the target list (no auto-extract). `classification` and
      the extracted row are **human-assigned**.
- [ ] Minors' data is encrypted at rest and access-controlled (audit §5.1).

**Done when:** a forwarded email reliably appears in the review inbox and a person
can file it into a structured, provenance-linked row.

> **Future enhancement (out of initial scope):** an **email-triage agent** that
> auto-classifies/extracts into the same tables. Adding it revisits D5
> (cloud-vs-local LLM) since a model would then see the data.

---

## Phase 4 — Player list features (built on the review inbox)
Each is a filing form (from the review inbox) + a list view + an export. Suggested
order (simplest first):
- [ ] **Late entries** (simple filing; creates/updates a `TournamentEntry`,
      `source = late_entry` — audit §4.1).
- [ ] **Withdrawals** (reason optional when roster status = alternate; recording
      sets `TournamentEntry.selection_status = withdrawn` — audit §2.4).
- [ ] **Scheduling avoidances** (adults) and **Division flexibility** (adults).
- [ ] **Pairing avoidances** (juniors).
- [ ] **Doubles pairing** — two-sided verification state machine + **random
      pairing queue** with odd-one-out handling; a random request is **binding**
      (no later self-found partner — audit §2.2, §3.6). Hardest; do last.
- [ ] **T-shirt cumulative list** — derived view over `TournamentEntry.t_shirt_size`
      across tournaments (audit §8 F1).
- [ ] **Player hotel stays** + **CVB sponsorship analytics** view (audit §1.2).

**Done when:** every list in the vision can be filed from the review inbox and
exported.

---

## Phase 5 — Polish & hardening
- [ ] PII: encryption at rest, access control, retention policy (audit §5.1).
- [ ] Audit trail for money (store calc inputs + rule version — audit §5.3).
- [ ] Multi-user TD access if needed (D8).
- [ ] Spreadsheet/PDF exports for all reports.
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
