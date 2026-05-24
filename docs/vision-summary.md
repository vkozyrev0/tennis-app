# CorpOps Tennis — Vision Summary

> Normalized restatement of `Tennis information for Claude.docx`. This is the
> source-of-truth digest the other docs build on. Where the original wording is
> ambiguous, the ambiguity is flagged in [audit.md](audit.md), not resolved here.

CorpOps Tennis is back-office tooling for a USTA tennis **Tournament Director (TD)**.
It has two largely separate halves:

1. **Officials operations** — a two-sided app (officials + administrator) for
   staffing tournaments with certified officials, lodging them, and paying them.
2. **Player/tournament operations** — an admin-only system that ingests the
   email parents and players send the TD and turns it into actionable lists.

---

## Part A — Officials App / Database

A two-platform application: an **end-user (official) platform** and an
**administrator (TD) platform**. Both must be easy to navigate.

### What officials do
- Maintain their profile: name, home address (street/city/state/zip), phone,
  email, USTA certifications (roving / chair / referee), dietary restrictions.
- Indicate which **dates** they are available, per tournament.
- Indicate whether they need a hotel.

### What the administrator (TD) does
- Enter **tournaments** (each has a unique name, runs 3–6 days) and their dates.
- Enter the **tennis site** location + address (used for mileage).
- Confirm selection of officials for specific dates.
- Assign **hotel rooms** from a managed room inventory.
- Set **pay rates** per USTA certification type.

### Hotel inventory (for officials)
Tracked per room block: hotel name, website, street/city/state/zip, phone,
confirmation number, cancellation info, check-in/check-out dates.

### Money rules
- **Pay** = certification rate (set by TD) applied to confirmed assignment.
- **Mileage** = round-trip miles (home ↔ site) **less the first 50 miles**,
  reimbursed at **$0.65/mile**, capped at **$100 maximum**.

### Reports
- Roster: who is confirmed for each tournament, by date, with site assignment
  and hotel assignment.
- Pay/mileage: total per official and total per tournament.

---

## Part B — Player / Tournament Operations (Juniors & Adults)

Core idea: parents and players email the TD about many different issues. A
system should **analyze those emails and produce structured lists**. Players do
not log in — email is the only player-facing channel; everything else is TD-side.

### Junior tournaments
- **Doubles partner pairing** — partnership is valid only when emails from
  **both** players (or parents) are received, each naming both players + the age
  division. List: age division, player 1, player 2, "both emails received?" flag.
  - **Random pairing** — players with no partner ask to be randomly paired.
    Queue them per division; pair with the next random request in that division.
- **Withdrawals** (after registration closes) — player emails a reason. No
  reason needed if they were on the alternate list. List: age division, player,
  event(s), reason, notes.
- **Late entries** (missed the deadline) — List: date, time, player name, age
  division, events, USTA number.
- **Avoidances (pairing)** — players from the same club, or siblings in the same
  event/division, request not to meet in the **first round**. List: age
  division, the player names who should not be drawn against each other.
- **T-shirt sizes** — cumulative spreadsheet across all tournaments (player,
  division, tournament, size). Needed because late entries never register on the
  USTA site and so never pick a size.
- **Hotels (player-reported)** — collect each player's hotel name. The local
  Convention & Visitors Bureau sponsors the tournament (cash or comp rooms for
  officials) based on room-night patterns, so a running list supports
  negotiating more sponsorship.

### Adult tournaments
- **Avoidances (scheduling)** — players email day/time avoidances.
- **Division flexibility** — players offer to play in another division if theirs
  is undersubscribed. List used to make adjustments after registration closes.

---

## Cross-cutting themes (not stated, but implied)
- The unifying engine on the player side is an **email triage agent**: read an
  inbound email, classify its intent, extract fields, route to the right list.
- A single **player identity** (USTA number) ties the doubles/withdrawal/late/
  avoidance/t-shirt/hotel lists together.
- Junior data involves **minors' PII** (names, addresses, contact info) — a
  privacy/security consideration that runs through the whole player side.
