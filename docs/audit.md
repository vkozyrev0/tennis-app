# CorpOps Tennis — Audit & Findings Register

The single register of everything that needs a decision or a fix. Audits the
vision for **validity** (is it buildable / well-defined?), **internal
consistency** (does it contradict itself?), and **non-collision** (do features
overlap, clash, or share names with different meanings?) — and tracks the
**doc-vs-source discrepancies** and **sample-data evidence** found along the way.

**Status leads each item:** ✅ resolved · 🔄 default applied, confirmation pending ·
⬜ open.
**Original severity** is shown as a muted *(was 🔴)* / *(was 🟡)* tag on resolved
items so history isn't lost: 🔴 must resolve before building · 🟡 should decide
soon · 🟢 minor (tag omitted to reduce noise).

> **TD review applied 2026-05-24.** The Tournament Director reviewed every finding
> and answered. Key changes from this round: registration deadline and late-entry
> deadline are **two distinct dates** (§2.5); pay rates are **per day per
> certification** with the role able to change day-to-day (§3.2); the TD supplies
> a **per-tournament player roster** keyed by USTA ID with selection status,
> t-shirt size, and dietary preference (§4.1); dietary restrictions appear on the
> confirmed-officials report (§2.3); hotel date mismatches are a **report alert**,
> not a hard block (§3.4); a random-pairing request is **binding** (§3.6).
>
> **Second review applied 2026-05-24.** The last two items are now closed: the
> roster is ingested via **spreadsheet upload** (§3.8), and **D5 is resolved** —
> there is **no automated LLM parsing for now; inbound email is human-reviewed**
> (§5.1). The triage agent is deferred to a future enhancement. **No open items
> remain.**

---

## 1. Terminology & feature collisions

### 1.1 ✅ "Avoidances" means two different things *(was 🔴)*
- **Junior** avoidances = *pairing* avoidances: **two or more** players should not
  be **drawn against each other** in the **first round** (same club / siblings).
  *Confirmed C1.*
- **Adult** avoidances = *scheduling* avoidances: a player can't play at certain
  **days/times**. *Confirmed C1.*

Same word, two unrelated data shapes and two unrelated downstream actions. If
both land in one "avoidances" list/table they will collide.
**Recommendation:** name them distinctly everywhere — `PairingAvoidance` (a group
of **2+ players** who must not meet, via `PairingAvoidanceMember`) and
`SchedulingAvoidance` (player ↔ day/time). The two are independent concepts, so
juniors could in principle have scheduling avoidances and adults pairing
avoidances — keeping them separate leaves both open.

*Also resolves a source wobble (was "same round" vs "first round"): it is the
**first round**.*

### 1.2 ✅ "Hotels" means two different things *(was 🟡)*
- **Officials hotels** = an *inventory the TD owns* (room blocks, confirmation
  numbers, assigned to officials).
- **Player hotels** = *data collected from players* (which hotel they booked),
  used only for sponsorship analytics.

These are genuinely different entities. The collision is only in the name — but
there is also a real, valuable **link**: player room-night patterns are the
evidence the TD uses to negotiate the comp rooms that *become* the officials'
hotel inventory. **Recommendation:** model as two tables (`HotelRoomBlock` vs
`PlayerHotelStay`) and add a sponsorship-analytics view that connects them.
*Confirmed: TD reserves rooms for officials; players report their hotel so the TD
earns complimentary rooms from that hotel (the CVB loop).*

### 1.3 ✅ "Administrator" = "Tournament Director" throughout
The doc uses both interchangeably. **Applied (default):** same role; **single TD
now**, multi-user/staff shared access deferred (D8).

### 1.4 ✅ Product / repo name
The source named no product; early docs invented "CortOps" and referenced a repo
"adks-tennis" that didn't match the working dir (`tennis-app`). **Resolved:**
unified to **CorpOps** across all docs; the ADK choice (D6) no longer rests on the
old repo name.

---

## 2. Internal-consistency issues

### 2.1 ✅ Two different user-interaction models *(was 🟡)*
- **Officials side**: officials *log in* and self-serve (the "end-user platform").
- **Player side**: players never log in — they **email**, and only the TD uses
  software.

This is consistent but worth stating explicitly so it isn't accidentally
"fixed": there is **no player login/portal** in scope. The player side is a
TD-facing inbox-to-lists tool, not a player-facing app.

### 2.2 ✅ Doubles partnership needs a two-sided match *(was 🟡)*
A partnership is only valid when **both** players' emails arrive, *each* naming
both players + division. That's a small state machine: `awaiting-second-email →
verified`. The system must correlate two separate emails as the same
partnership (by the named players + division), which is non-trivial when names
are spelled/abbreviated differently across the two emails. Flagged so it isn't
treated as a simple form.

### 2.3 ✅ "Dietary restrictions" — now shown on the confirmed-officials report
**TD decision:** dietary restrictions **must appear on the confirmed-officials
report**. Kept on `Official`; added as a column to the confirmation roster report
(roadmap Phase 1).

### 2.4 ✅ Alternate-list status — sourced from the TD roster
**TD decision:** the TD supplies, per tournament, the list of players with their
**selection status** (selected / alternate / withdrawn) — see §4.1. Withdrawals
reference that roster: a player whose status is `alternate` needs **no reason**.
`Withdrawal` keeps an optional `reason`; `was_alternate` is read from the roster
(`TournamentEntry.selection_status`) rather than re-entered.

### 2.5 ✅ "registration closes" vs "the deadline" — two distinct dates *(was 🟡)*
**TD decision:** the **registration deadline** and the **late-entry deadline** are
**different dates**, both supplied by the TD at tournament setup. The tournament
record must carry: `registration_deadline`, `late_entry_deadline`, and the
**match-play** `play_start_date` / `play_end_date`. (Supersedes the earlier
single-date assumption.) See [data-model.md](data-model.md) §Tournament.

---

## 3. Validity / buildability gaps (need a decision)

### 3.1 ✅ Mileage rule — resolved *(was 🔴)*
"Round-trip mileage from home to site **less the first 50 miles**, $0.65/mile,
$100 max." All four points below are now settled (U1, TD, U2, sample evidence).
- **Resolved (U1):** the 50-mile deduction is taken off the **round-trip total**
  (`round_trip_miles − 50`).
- **Resolved (TD):** the $100 cap is a **hard ceiling**. It is reached at ~203.8
  round-trip miles after the 50-mile deduction (153.85 reimbursable × $0.65).
- **Resolved (U2):** mileage comes from **geocoding via Google Maps** (compute
  home↔site distance), with **manual entry as a fallback** when the lookup is
  unavailable. This is a real external dependency (cost + API-key management).
- **Sample evidence** (`Officials Mileage Workbook.xlsx`): the TD enters a
  **one-way** distance; the sheet computes `(2 × one_way) − 50` reimbursable
  miles, with **no $ rate and no cap in the sheet** — the $0.65 conversion and
  $100 cap are a separate pay step. Distance is collected as an **official × site
  matrix**, reused across tournaments. Full detail in §3.7 (S1–S6).

### 3.2 ✅ Pay rate is per day **and** per certification — role can vary by day *(was 🔴)*
**TD decision:** rates are assigned **per day per certification/position**, and an
official can work **different roles on different days** (e.g. Friday as a roving
official, Saturday as a site referee, each at its own rate). Pay is therefore
computed **per day**: `pay = Σ over assigned days of rate(role worked that day)`.
This supersedes a single `working_as` per assignment — the role + rate now live on
a **per-day** record (`AssignmentDay`), each snapshotting `rate_applied`. See
[data-model.md](data-model.md) §Assignment / §AssignmentDay.

### 3.3 ✅ Email ingestion mechanism — dedicated forwarding address *(was 🔴)*
The entire player side depends on reading the TD's email. Options: Gmail/Graph
API on the TD's mailbox, a dedicated forwarding address the TD forwards to, or
IMAP polling. **Applied (default):** a **dedicated forwarding address** — smallest
privacy blast radius (§5.2). Reversible; revisit if the TD needs auto-capture
without forwarding. See [roadmap.md](roadmap.md) Phase 3.

### 3.4 ✅ Hotel-room inventory: counts decrement; date mismatches are flagged *(was 🟡)*
**TD decision:** track room **counts** that decrement as officials are assigned
(`rooms_remaining = room_count − active assignments`; no booking past
`room_count` — a hard guard). When an official's needed **check-in/check-out
doesn't match the reservation window**, the system must **alert the TD in the
report** (not silently block); the TD then adjusts the reservation with the hotel
and updates the hotel inventory. So the date check is a **report-level alert**
while the room-count cap stays a hard guard. See
[data-model.md](data-model.md) §HotelRoomBlock and the roster report (roadmap
Phase 1).

### 3.5 ✅ USTA platform integration scope *(was 🟡)*
"Pair them on the USTA platform" — **Applied (default):** **manual** TD action;
the app produces lists, a human acts on the USTA website. **No USTA API** in
scope. Reversible if an API is ever pursued (scope would grow substantially).

### 3.6 ✅ Random-pairing: a random request is binding *(was 🟡)*
**TD decision:** FIFO per `(tournament, division)`; an **odd requester stays
`waiting`**. A player who has requested random pairing **cannot later switch to a
self-found partner** — they must play with whoever is randomly assigned.
(Supersedes the earlier "set to `withdrawn` if they later submit a mutual
partnership" rule — a random request is now **binding**.) See
[data-model.md](data-model.md) §RandomPairingQueue.

### 3.7 Sample mileage data evidence (`Officials Mileage Workbook.xlsx`)
A real sample — **47 officials** (rows 2–48) × 3 site columns (JDS / RSTC / ROME) —
with **formula** cells (e.g. `=(2*86)-50`) showing how mileage is collected today.
Findings below were **verified directly against the file's formula cells**.

| ID | Finding | Orig. sev | Status | Action / note |
|----|---------|-----|--------|---------------|
| S1 | **Mileage is a matrix: official × site.** Distance is per (official, site), reused across tournaments at that venue. | 🟡 | ✅ | Added `OfficialSiteDistance` + `Site.code` in [data-model.md](data-model.md). |
| S2 | **Input unit is one-way miles; sheet doubles then −50** → `(2 × one_way) − 50` reimbursable miles. Confirms U1. | 🔴 | ✅ | Mileage formula in data-model mirrors this; geocoding (U2) returns one-way, then ×2. |
| S3 | **Sheet stores reimbursable *miles* only** — no `$0.65`, no `$100` cap (e.g. Grace ROME `=184*2-50` → 318 mi; Woodard JDS → 254 mi — both uncapped). | 🟡 | ✅ | Cap + dollar conversion applied at the pay-computation step, not at collection. |
| S4 | **Data quality: `182` is a placeholder** — the identical `(2*116)−50` is reused for **6 officials with different addresses** (Dalton, Grace, Johnson, Jones, Smulevitz, Stewart — all RSTC); plus missing zips (e.g. Smulevitz) and one out-of-state official (Meadows, AL). | 🟡 | ✅ | **Applied:** mileage pay requires a real geocoded/manual `OfficialSiteDistance`; computation is blocked on a missing address or unverified placeholder (data-model §Validation S4). |
| S5 | **No clamp at zero in the sheet** — `(2 × one_way) − 50` goes negative for any one-way < 25 mi (smallest real value in the sheet is 10). | 🟢 | ✅ | Model uses `max(round_trip − 50, 0)`. |
| S6 | **Matrix is sparse / incomplete: 18 of 47 officials have no distance at all**, and most others have only 1–2 of the 3 sites filled. Mileage is uncomputable for them until backfilled. | 🟡 | 🔄 | Distances are collected lazily per (official, site); roadmap Phase 1 adds a task to seed/backfill the matrix (skipping placeholders) and surface officials missing a distance. |

### 3.8 ✅ Roster **ingestion mechanism** — spreadsheet upload *(was 🟡)*
The §4.1 decision says the TD *supplies* a per-tournament roster (`TournamentEntry`)
keyed by USTA ID. **TD confirmed:** ingestion is a **spreadsheet upload** (CSV/XLSX)
whose columns map to `TournamentEntry` (USTA ID, name, division, events, selection
status, t-shirt size, dietary), plus manual add/edit for late entries. The Phase 1
importer maps the USTA player-list export to those columns. See
[roadmap.md](roadmap.md) Phase 1.

---

## 4. Data-integrity / identity (non-collision at the record level)

### 4.1 ✅ One player identity across many lists *(was 🔴)*
A single player can appear in doubles, withdrawals, late entries, avoidances,
t-shirt, and hotel lists — often within one tournament. Without a shared key
these become six disconnected spellings of the same person.
**Recommendation:** make **USTA number** the player primary key (it's already
captured on late entries; capture it everywhere). The cumulative t-shirt list in
particular only works if players de-duplicate across tournaments.

**TD decision:** the TD supplies, **per tournament**, the authoritative player
list keyed by **USTA ID**, each row carrying **selection status** (selected /
alternate / withdrawn), **t-shirt size**, and **dietary preference**. This roster
(`TournamentEntry`, see [data-model.md](data-model.md)) is the source of truth for
player identity, the alternate list (§2.4), and t-shirt history (§8 F1); email
extraction augments it (late entries, withdrawal reasons, avoidances, hotels)
rather than being the only source.

### 4.2 ✅ Officials and players are separate populations
Both are "people with addresses," but they never mix. Keep them as separate
entities; don't over-generalize into one "Person" table prematurely.

### 4.3 ✅ Email-to-entity provenance *(was 🟡)*
Every extracted list row originates from an email. Keep a link from each row back
to its source email (message-id) for auditing, dedup (same email processed
twice), and handling corrections/follow-up emails.

---

## 5. Privacy, security & compliance

### 5.1 ✅ Minors' PII — protected; no automated parsing for now *(was 🔴)*
Junior players are **minors**. Their names, contact details, USTA numbers, and
hotel locations are sensitive. **TD confirmed:** minors' data must be
**encrypted** and **never publicly available**. **Adopted as a first-class
constraint:** encryption at rest, access control, and a retention policy.
**D5 resolved:** there is **no automated LLM parsing at this point** — inbound
email is **human-reviewed** and filed by the TD/staff. Because no model sees the
data, the cloud-vs-local question is moot for now; revisit it only if/when
automated extraction is added later (the triage agent becomes a future
enhancement, not part of the initial build).

### 5.2 ✅ Mailbox access blast radius *(was 🟡)*
Reading the TD's inbox may expose unrelated personal mail. **Applied:** a
**dedicated forwarding/tournament address** (ties to §3.3/D4) rather than
full-mailbox read.

### 5.3 ✅ Financial data *(was 🟡)*
Pay and mileage are money. **Applied:** `Assignment` snapshots `computed_pay`,
`computed_mileage`, and `rule_version`, with per-day `rate_applied` on
`AssignmentDay`; `CertificationRate` carries `effective_from` — so every figure is
reproducible from stored inputs + rule version. **TD confirmed:** officials'
personal and pay data is sensitive and must be **protected from public view**
(access-controlled, encrypted at rest).

---

## 6. What's solid (validated, build as described)
- Officials availability → confirmation → assignment → pay/mileage → report is a
  clean, coherent pipeline. 🟢
- The "email → classify → extract → list" pattern is a strong, consistent spine
  for the entire player side. **Near-term it is done by human review** (TD/staff
  read each forwarded email and file it); automating the classify/extract step
  with an agent/ADK is a natural **future enhancement** (D5/§5.1). 🟢
- Tournament as the central organizing entity (name, 3–6 days, junior/adult,
  site) is sound and links both halves of the system. 🟢
- The CVB sponsorship loop (player hotel data → negotiate comp rooms → officials'
  inventory) is a genuinely smart, internally consistent feedback loop. 🟢

---

## 7. Decisions
Consolidated from above. **All decisions are now made** (defaults accepted where
noted, all reversible). D5 is resolved by deferring automated parsing in favor of
human review.

| # | Decision | Blocks | Resolution (status) |
|---|----------|--------|---------------------|
| D1 | Mileage: 50 miles round-trip total vs per leg? + cap | Pay/mileage calc | ✅ Round-trip total (U1); $100 cap is a hard ceiling (§3.1) |
| D2 | Certification pay rate unit + which rate when multi-certified | Pay calc | ✅ Per day **per certification**; role can vary day-to-day → per-day rate (§3.2) |
| D3 | Mileage distance source: manual / auto / both | Officials app | ✅ Google Maps geocoding, manual fallback (U2) |
| D4 | Email ingestion: API mailbox / forwarding address / IMAP | Entire player side | ✅ Dedicated forwarding address (§3.3) |
| D5 | LLM for parsing: cloud API vs local (minors' PII) | Player side + privacy | ✅ **No automated parsing now — human review.** Cloud-vs-local is moot until extraction is automated later (§5.1) |
| D6 | Tech stack / which "ADK" (if any) | Everything | ✅ Recommended shape adopted (roadmap §Stack); confirm exact ADK at Phase 0 |
| D7 | USTA: manual only, no API | Doubles/late-entry scope | ✅ Manual only (§3.5) |
| D8 | Single TD vs multi-user access | Auth model | ✅ Single TD now, multi later (§1.3) |

---

## 8. Doc-vs-source discrepancies (generated docs vs the source vision)
Places where the generated docs drifted from what the source actually asks for.

| ID | Finding | Orig. sev | Status | Action / note |
|----|---------|-----|--------|---------------|
| F1 | **T-shirt list was lost in the data model** — source wants a cumulative list (player, division, tournament, size); the model had collapsed it to one `latest_tshirt_size` field on `Player`. | 🔴 | ✅ | History carried by `TournamentEntry.t_shirt_size` (one row per player per tournament — §4.1); "latest" is a derived view. Keep history, don't collapse. |
| F2 | **`Withdrawal` was missing `age_division`** — a source column, present on every sibling list. | 🟡 | ✅ | Now satisfied via the roster: `age_division` (and `was_alternate`) are **read from `TournamentEntry`** at report time, not stored on `Withdrawal` (single source of truth — §4.1). All source columns appear on the report. |
| F3 | **Late-entry `usta_number` duplicated** — `LateEntry` stores it while `Player` already keys on it. | 🟢 | ✅ | **Applied:** dropped the redundant column; `LateEntry.player_id` carries the USTA number. |

---

## 9. Priority shortlist

**Resolved / applied:** all collisions (§1.1–§1.4), every consistency item
(§2.1–§2.5), all buildability gaps (§3.1–§3.6, several now TD-confirmed), the
sample-data findings (§3.7 S1–S6; **S6 tracked as a Phase 1 distance-backfill
task**), identity & provenance (§4.1–§4.3), financial auditability (§5.3), mailbox
scope (§5.2), and all doc-vs-source discrepancies (§8 F1–F3). **All decisions
D1–D8 are decided** (defaults accepted where noted, all reversible; D5 resolved by
deferring parsing in favor of human review).

**No open items remain.** The final two are now closed:
- **D5 / §5.1 — minors' PII / parsing.** Resolved: **no automated LLM parsing for
  now — inbound email is human-reviewed**. The cloud-vs-local question is moot
  until extraction is automated later; the triage agent is a **future
  enhancement**, not part of the initial build.
- **§3.8 — roster ingestion.** Confirmed: **spreadsheet (CSV/XLSX) upload** mapped
  to `TournamentEntry`, plus manual add for late entries.

**Confirmed by the TD (2026-05-24 review):** §1.1 (split avoidances), §1.2 (two
hotel concepts), §2.1–§2.2, §2.3 (dietary **on** the confirmed-officials report),
§2.4 (alternate list from the roster), §2.5 (registration ≠ late-entry deadline —
**two dates**), §3.1 (cap is a hard ceiling), §3.2 (per-day **per-certification**
pay), §3.4 (hotel date mismatch = report alert), §3.5/D7 (no USTA API), §3.6
(binding random pairing), §4.1 (TD-supplied per-tournament roster), §5.1/§5.3
(encryption + non-public for minors and officials). New build dependency:
**per-tournament roster import** (`TournamentEntry`) — added to roadmap Phase 1.
