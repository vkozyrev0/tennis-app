# CorpOps Tennis — Data Model

Proposed entities derived from the vision, with the collisions from
[audit.md](audit.md) already resolved (e.g., split avoidances, split hotels).
Storage-agnostic; field types are indicative. **PK** = primary key,
**FK** = foreign key.

---

## Shared / core

### Tournament
The central entity linking both halves of the system.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `name` | unique |
| `type` | `junior` \| `adult` |
| `play_start_date`, `play_end_date` | match-play window, 3–6 days |
| `registration_deadline` | normal registration cutoff; withdrawals happen after this |
| `late_entry_deadline` | **distinct** date for late entries (§2.5) |
| `site_id` | FK → Site |

> All three dates (`registration_deadline`, `late_entry_deadline`, and the
> `play_start_date`/`play_end_date` match-play window) are supplied by the TD at
> tournament setup. Registration and late-entry deadlines are **different dates**
> (audit §2.5).

### Site
| Field | Notes |
|-------|-------|
| `id` | PK |
| `code` | short label (e.g., `JDS`, `RSTC`, `ROME` from the sample workbook) |
| `name`, `street`, `city`, `state`, `zip` | address used for mileage |
| `lat`, `lng` | optional, for auto-distance (D3) |

### OfficialSiteDistance
One-way home↔site distance, cached per **(official, site)** — the unit the sample
mileage workbook actually collects (a matrix of officials × sites). Reused across
every tournament held at that site, so distance is entered/geocoded once.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `official_id` | FK → Official |
| `site_id` | FK → Site |
| `one_way_miles` | TD-entered or geocoded (D3/U2) |
| `source` | `geocoded` \| `manual` |

> The matrix is **sparse**: a row exists only for an (official, site) pair whose
> distance is known. In the sample workbook, **18 of 47 officials had no distance
> at all** and most others had only 1–2 of 3 sites filled, so mileage is simply
> uncomputable for them until a value is entered/geocoded (audit §3.7 S4/S6). Do
> **not** import the `182` placeholder reused across 6 officials — treat it as
> missing.

---

## Part A — Officials

### Official
| Field | Notes |
|-------|-------|
| `id` | PK |
| `first_name`, `last_name` | |
| `street`, `city`, `state`, `zip` | home address (mileage origin) |
| `phone`, `email` | |
| `dietary_restrictions` | shown on the confirmed-officials report (audit §2.3) |
| `lat`, `lng` | optional, for auto-distance |

### Certification
| Field | Notes |
|-------|-------|
| `id` | PK |
| `official_id` | FK → Official |
| `type` | `roving` \| `chair` \| `referee` |

### CertificationRate
Set by TD; **per-day** rate by certification type (D2). The applicable rate is
chosen per day by `AssignmentDay.working_as`, so an official can be paid different
rates on days they work different roles (audit §3.2).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `type` | `roving` \| `chair` \| `referee` |
| `rate_per_day` | money |
| `effective_from` | rate version, for auditability (audit §5.3) |

### Availability
Official declares available dates per tournament.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `official_id` | FK |
| `tournament_id` | FK |
| `date` | one row per available day (or store a date range) |
| `hotel_needed` | bool |

### HotelRoomBlock
Officials lodging inventory the TD manages (audit §1.2, §3.4).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `hotel_name`, `website` | |
| `street`, `city`, `state`, `zip`, `phone` | |
| `confirmation_number`, `cancellation_info` | |
| `check_in`, `check_out` | block window |
| `room_count` | total rooms in the block |

**Allocation rules (§3.4):** `rooms_remaining = room_count − count(active assignments
on the block)`. Room-count is a **hard guard** — no booking past `room_count`. The
**date check is a report alert, not a block**: if the official's
`needed_check_in` / `needed_check_out` fall outside `[check_in, check_out]`, flag
it on the roster report so the TD can adjust the reservation with the hotel and
update the inventory.

### Assignment
TD confirms an official for a tournament + hotel. The **role and rate are per day**
(see `AssignmentDay`), because an official can work different positions on
different days (audit §3.2).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `official_id`, `tournament_id` | FK |
| `hotel_block_id` | FK → HotelRoomBlock (nullable) |
| `needed_check_in`, `needed_check_out` | what the official actually needs; compared to the block window for the mismatch alert (§3.4) |
| `computed_pay`, `computed_mileage` | snapshot of calc (audit §5.3) |
| `rule_version` | mileage/pay rule version used, for reproducibility (§5.3) |

### AssignmentDay
One row per assigned day; the role worked that day picks the rate (audit §3.2).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `assignment_id` | FK → Assignment |
| `date` | a single day within the tournament's match-play window |
| `working_as` | certification/position worked **that day** (`roving` \| `chair` \| `referee`) |
| `rate_applied` | per-day rate for that role, snapshotted at confirm time (§5.3) |

**Derived — Pay** = `Σ over AssignmentDay of rate_applied`
(i.e. each day priced at the rate for the role worked that day — e.g. Friday
roving + Saturday referee at their respective rates).
**Derived — Mileage** (matches the sample workbook's `(2 × one_way) − 50` rule):
```
round_trip_miles  = 2 × OfficialSiteDistance.one_way_miles
reimbursable_miles = max(round_trip_miles − 50, 0)          # D1; sample stores this
mileage_pay        = min(reimbursable_miles × 0.65, 100)    # $0.65/mi, $100 cap
```
The sample workbook stops at `reimbursable_miles` (no $ rate, no cap); the cap and
dollar conversion are applied here, at the pay-computation step.

**Validation (S4):** mileage pay requires a real `OfficialSiteDistance` (geocoded
or an explicit manual entry). Block computation when the official's address is
missing or the distance is an unverified placeholder.

---

## Part B — Player operations

### Player
One stable identity across every list. **USTA number is the natural key**
(audit §4.1). Holds only attributes that don't change tournament-to-tournament.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `usta_number` | unique business key |
| `first_name`, `last_name` | |

> Per-tournament attributes — **age division, selection status, t-shirt size,
> dietary preference** — live on `TournamentEntry`, not on `Player`, because they
> vary by tournament. "Latest t-shirt size" is a derived view over the player's
> `TournamentEntry` rows (F1 — keep history, don't collapse).

### TournamentEntry  (TD-supplied per-tournament roster — audit §4.1)
The authoritative roster the TD supplies for each tournament, keyed by USTA ID.
Source of truth for player identity in a tournament, the alternate list (§2.4),
and t-shirt history (F1). Email extraction (late entries, withdrawal reasons,
avoidances, hotels) augments it.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | FK; unique together |
| `age_division` | division for this tournament |
| `events` | event(s) entered |
| `selection_status` | `selected` \| `alternate` \| `withdrawn` (drives §2.4) |
| `t_shirt_size` | per-tournament; history across rows = cumulative list (F1) |
| `dietary_preference` | player dietary preference for this tournament |
| `source` | `usta_roster` \| `late_entry` \| `manual` (late entries added by TD) |

### EmailMessage
Provenance for every filed row (audit §4.3). Emails forwarded to the dedicated
address land here as a **review inbox**. **No automated parsing** for now (D5 /
audit §5.1): a person reads each message, sets `classification`, and keys the
target row(s) by hand.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `message_id` | dedup key |
| `received_at`, `from_address`, `subject`, `body` | |
| `tournament_id` | FK (set by the reviewer) |
| `classification` | **human-assigned**: doubles \| withdrawal \| late_entry \| pairing_avoidance \| scheduling_avoidance \| division_flex \| hotel \| other |
| `filed`, `needs_followup` | review-workflow flags (reviewer-set) |

> A future **triage agent** could auto-suggest `classification` and the extracted
> fields, leaving the human to confirm — but that is out of initial scope and
> would revisit D5 (cloud-vs-local LLM). For now the fields above are set by a
> person.

### DoublesRequest  /  DoublesPair
Two-sided verification state machine (audit §2.2).
- **DoublesRequest**: `id`, `tournament_id`, `age_division`,
  `requesting_player_id`, `partner_named`, `wants_random` (bool),
  `source_email_id`.
- **DoublesPair**: `id`, `tournament_id`, `age_division`, `player1_id`,
  `player2_id`, `both_emails_received` (bool), `pairing_type`
  (`mutual` \| `random`), `email1_id`, `email2_id`.

### RandomPairingQueue
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `age_division` | |
| `player_id` | |
| `enqueued_at` | FIFO order |
| `status` | `waiting` \| `paired` (audit §3.6) |

**Rules (§3.6):** FIFO per `(tournament, age_division)`. A new random requester
pairs with the longest-waiting `waiting` row in the same division → both form a
`DoublesPair` (`pairing_type = random`) and flip to `paired`. An odd requester
stays `waiting`. A random request is **binding**: once queued, a player **cannot**
switch to a self-found partner — they play with whoever is randomly assigned.

### Withdrawal
The email-driven withdrawal detail. Report columns (age division, player,
event(s), reason, notes — F2) come from this row joined to `TournamentEntry`.
Recording a withdrawal also sets the roster `selection_status = withdrawn`.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | |
| `events` | event(s) withdrawn from |
| `reason` | **optional** when the player's roster `selection_status` is `alternate`; otherwise required (audit §2.4) |
| `notes` | |
| `source_email_id` | |

> `was_alternate` and `age_division` are **read from `TournamentEntry`**, not
> re-entered here (single source of truth — §4.1).

### LateEntry
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | `player_id` carries the USTA number (F3 — no duplicate column) |
| `request_date`, `request_time` | when the late-entry email arrived |
| `age_division`, `events` | as requested in the email |
| `source_email_id` | |

> Processing a late entry creates/updates the player's `TournamentEntry`
> (`source = late_entry`), so late entrants land on the same roster — and get a
> t-shirt size and dietary preference recorded by the TD (audit §4.1).

### PairingAvoidance (juniors)
A group of **two or more** players who must not meet in the **first round**
(audit §1.1; confirmed C1 — same club or siblings). Modeled as a header +
members so a group can exceed two players.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `age_division` | |
| `relationship` | `same_club` \| `siblings` |
| `source_email_id` | |

### PairingAvoidanceMember
The players in a `PairingAvoidance` group (2+ rows per group).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `pairing_avoidance_id` | FK → PairingAvoidance |
| `player_id` | FK → Player |

### SchedulingAvoidance (adults)
Player↔day/time (audit §1.1).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | |
| `avoid_day`, `avoid_time_range` | |
| `source_email_id` | |

### DivisionFlexibility (adults)
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | |
| `home_division` | |
| `willing_divisions` | list |
| `source_email_id` | |

### PlayerHotelStay  (CVB sponsorship analytics — audit §1.2)
Players report which hotel they stayed in so the TD can show room-night patterns
to the CVB and earn complimentary officials' rooms / sponsorship (confirmed C2).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | |
| `hotel_name` | free-text, normalize for analytics |
| `source_email_id` | |

### T-shirt size  (cumulative history — F1, carried by `TournamentEntry`)
Not a separate table: `TournamentEntry.t_shirt_size` already gives one row per
player per tournament, so the set of a player's entries **is** the cumulative
history. "Latest size" = derived view, the most recent entry by tournament date.
This keeps a player's most recent size known even when they are a late entry in a
future tournament (late entries never pick a size on the USTA site; the TD records
it on their `TournamentEntry`, `source = late_entry`). F1 satisfied — history
kept, not collapsed.

---

## Relationship sketch
```
Site 1───* Tournament *───* (Availability, Assignment) *───1 Official *───* Certification
  │                                │  └─* AssignmentDay (per-day role+rate)  CertificationRate (by type)
  └──* OfficialSiteDistance *──────┤   (one-way miles per official×site)
                                   └─* HotelRoomBlock (allocated via Assignment; date mismatch → report alert)

Tournament *───* TournamentEntry *───1 Player        (TD roster: status, division, t-shirt, dietary)
           │        ▲ (status=withdrawn; t-shirt history; alternate list)
Tournament *───* EmailMessage ──┬─* DoublesRequest ─→ DoublesPair ←─ RandomPairingQueue
                                ├─* Withdrawal            → sets TournamentEntry.selection_status
                                ├─* LateEntry             → creates TournamentEntry (source=late_entry)
                                ├─* PairingAvoidance *─* PairingAvoidanceMember (juniors, 2+ players)
                                ├─* SchedulingAvoidance   (adults)
                                ├─* DivisionFlexibility   (adults)
                                └─* PlayerHotelStay ─→ CVB analytics
All player rows ───* Player (key: usta_number); per-tournament attrs on TournamentEntry
```
