# CourtOps Tennis — Planning Docs

Planning and audit for the CourtOps tennis project, derived from
`Tennis information for Claude.docx` (the TD's vision).

## What's here
| Doc | Purpose |
|-----|---------|
| [vision-summary.md](vision-summary.md) | Normalized restatement of the vision — the source-of-truth digest. |
| [audit.md](audit.md) | The single audit & findings register — collisions, consistency/validity gaps, doc-vs-source discrepancies, sample-data evidence, decisions (D1–D8), status, and a priority shortlist. |
| [data-model.md](data-model.md) | Proposed entities & relationships, with collisions already resolved. |
| [roadmap.md](roadmap.md) | Phased build plan (Phase 0 → 5) and dependency map. |

## The system in one paragraph
Back-office tooling for a USTA Tournament Director, in two loosely-coupled halves:
**(A) an officials app** — officials declare availability, the TD confirms
assignments, lodging, and computes pay + mileage; and **(B) player operations** —
a **review inbox** where parent/player email (forwarded to a dedicated address) is
**human-reviewed** and filed into structured lists (doubles, withdrawals, late
entries, avoidances, t-shirt sizes, hotels). No automated parsing in the initial
build; an email-triage agent is a possible future enhancement.

## Status — TD review complete (2026-05-24)
The Tournament Director reviewed the audit; **all findings are now resolved — no
open items**. Notable confirmed requirements:
- **Two deadline dates** — registration deadline ≠ late-entry deadline; plus the
  match-play window (audit §2.5).
- **Pay is per day per certification** — an official can work different roles on
  different days, each at its own rate (audit §3.2).
- **TD supplies a per-tournament roster** (`TournamentEntry`) keyed by USTA ID with
  selection status, t-shirt size, dietary preference — source of truth for the
  alternate list and t-shirt history (audit §4.1).
- **Dietary on the confirmed-officials report**; **hotel date mismatch = report
  alert** (audit §2.3, §3.4); **random pairing is binding** (audit §3.6);
  **encryption + non-public** for minors' and officials' data (audit §5).
- **No automated email parsing (D5)** — inbound email is **human-reviewed** and
  filed; the triage agent is a future enhancement (audit §5.1).
- **Roster ingestion = spreadsheet (CSV/XLSX) upload** mapped to `TournamentEntry`
  (audit §3.8).
- **POC stack (D6):** **Postgres** (localhost, default admin creds for the POC),
  a **Python API server**, and a **pure HTML/CSS** frontend (roadmap §Stack).

## What's still open
- **Nothing.** All decisions D1–D8 are made. Remaining work is execution.
  (POC uses default DB creds — harden before any shared deployment; see roadmap
  §Stack security note.)

## Other solid points
- 🟢 The email→classify→extract→list spine is sound; for now it runs as **human
  review**, with an agent as a natural future upgrade.
- 🟢 CVB loop: player hotel data → negotiate comp rooms → officials' inventory.

See [audit.md §7](audit.md) for the full decision table (D1–D8).

## Recommended next step
Execute Phase 0 — scaffold the POC stack (Postgres + Python API + HTML/CSS) and
the core schema — then the CRUD slice of Phase 1 (officials admin tool + roster
import). The fastest path to something usable.
