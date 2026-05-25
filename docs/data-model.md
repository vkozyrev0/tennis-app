# CourtOps Tennis — Data Model

Proposed entities derived from the vision, with the collisions from
[audit.md](audit.md) already resolved (e.g., split avoidances, split hotels).
Storage-agnostic; field types are indicative. **PK** = primary key,
**FK** = foreign key.

> **Build status (POC):** ✅ implemented · 🔭 planned (designed, not yet built).
> **Part A is fully implemented** (incl. Certification + Availability);
> **Part B (player operations) is entirely 🔭** except `Player`/`TournamentEntry`,
> which the roster shares. Markers below call out where the model and the running
> app differ.

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

> A tournament can be held at **more than one site**, so Site is a
> **many-to-many** via `tournament_site` (not a single `site_id`).
>
> All three dates (`registration_deadline`, `late_entry_deadline`, and the
> `play_start_date`/`play_end_date` match-play window) are supplied by the TD at
> tournament setup. Registration and late-entry deadlines are **different dates**
> (audit §2.5).

### tournament_site  (Tournament ↔ Site, M2M)
| Field | Notes |
|-------|-------|
| `tournament_id` | FK → Tournament (PK part) |
| `site_id` | FK → Site (PK part) |

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

### Certification  ✅ *built (migration 0006)*
Which certifications each official holds. **Enforced:** when an official has any
certifications on file, an assignment day's `working_as` role must be one they hold
(409 otherwise); if none are recorded, any role is allowed (data may be
incomplete). Managed as chips on the Official detail.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `official_id` | FK → Official |
| `type` | one of 5: `roving_official` \| `chair_umpire` \| `tournament_referee` \| `deputy_referee` \| `referee_in_training` |

### CertificationRate
Set by TD; **per-day** rate by certification type (D2). The applicable rate is
chosen per day by `AssignmentDay.working_as`, so an official can be paid different
rates on days they work different roles (audit §3.2).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `type` | one of 5: `roving_official` \| `chair_umpire` \| `tournament_referee` \| `deputy_referee` \| `referee_in_training` |
| `rate_per_day` | money |
| `effective_from` | rate version, for auditability (audit §5.3) |

### Availability  ✅ *built — TD-entered (migration 0007)*
Available dates per official per tournament. **Built:** the TD records dates on the
tournament **Availability** tab (`PUT .../availability` replaces an official's set);
`hotel_needed` is captured. Officials' self-service entry remains Phase 2.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `official_id` | FK |
| `tournament_id` | FK |
| `date` | one row per available day (or store a date range) |
| `hotel_needed` | bool |

### Hotel  (property)  and  RoomBlock  (inventory)
Hotels are **split** from room blocks (the property vs. the allocation at it).

**Hotel** — the property:
| Field | Notes |
|-------|-------|
| `id` | PK |
| `name`, `website` | |
| `street`, `city`, `state`, `zip`, `phone` | |

**RoomBlock** — an inventory allocation at a hotel (audit §1.2, §3.4):
| Field | Notes |
|-------|-------|
| `id` | PK |
| `hotel_id` | FK → Hotel |
| `tournament_id` | FK → Tournament (nullable); scopes the block for the per-tournament report |
| `kind` | `player` (discounted hotel **rates for players**) \| `official` (comp **rooms for officials**) — migration 0010 |
| `confirmation_number`, `cancellation_info` | |
| `check_in`, `check_out` | block window |
| `room_count` | total rooms in the block |

> **Two purposes (TD clarification):** `kind='player'` blocks are the discounted
> rates offered to players; `kind='official'` blocks are comp rooms for officials
> needing accommodation. The Assignment **Hotel assignment** draws **only** from
> `official` blocks, and the report's **officials-needing-accommodation roster**
> lists each housed official + hotel + the night span they work.

**Allocation rules (§3.4):** the **date check is implemented** — if an assignment's
worked dates fall outside `[check_in, check_out]`, the summary returns
`hotel_date_mismatch` so the TD can adjust the reservation. The **room-count cap is
enforced ✅**: assigning an official to a full block returns **409**, and
`rooms_remaining` (= `room_count` − assignments using the block) is surfaced in the
room-block list and the assignment room-block dropdown.

### Assignment  (Tournament ↔ Official)
TD assigns an official to a tournament, with a **venue site** (for mileage) and an
optional **room block**. The **role and rate are per day** (see `AssignmentDay`).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `official_id` | FK; UNIQUE together (one assignment per official per tournament) |
| `site_id` | FK → Site (nullable); the venue the official travels to → mileage via `OfficialSiteDistance` |
| `room_block_id` | FK → RoomBlock (nullable); capacity-checked on assign |
| `snapshot_pay`, `snapshot_mileage`, `snapshot_total` | frozen money at the last change (§5.3) |
| `rule_version`, `snapshot_at` | pricing-rule id + timestamp of the snapshot |

> Pay, mileage, and `hotel_date_mismatch` are **computed** in the summary endpoint
> and **snapshotted** onto the assignment (`snapshot_pay/mileage/total`,
> `rule_version`, `snapshot_at`) on every change (create / edit / add-day /
> remove-day), so a figure is reproducible later even if rates or distances change
> (§5.3, migration `0005`).

### AssignmentDay
One row per assigned day; the role worked that day picks the rate (audit §3.2).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `assignment_id` | FK → Assignment |
| `work_date` | a single worked day; UNIQUE per `(assignment_id, work_date)` |
| `working_as` | position worked **that day** (one of the 5 `certification_type` values) |
| `rate_applied` | per-day rate for that role, snapshotted when the day is added (§5.3) |

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

**Validation (S4):** mileage needs an `OfficialSiteDistance` for the assignment's
`(official, site)`. **As built**, when none exists the summary returns
`mileage = null` + `missing_distance = true` (surfaced as "no distance" in the UI)
rather than hard-blocking; the cap and the `max(…,0)` floor are applied. *Still
🔭:* importing the workbook matrix and rejecting the `182` placeholder, and any
hard block on unverified distances.

---

## Part B — Player operations  🚧 *started*
> **Built so far:** `Player` + `TournamentEntry` (roster, shared with Part A), the
> **`EmailMessage` review inbox**, and the first list — **`LateEntry`** (migration
> 0011), with a "file from email" flow. **Still 🔭:** doubles, withdrawals,
> avoidances, division flexibility, player hotel stays. Human-review workflow, no
> auto-parsing (D5/§5.1).

### Player  ✅ *(built — mutable, with history)*
One stable identity across every list. **USTA number is the natural key**
(audit §4.1). The record is **mutable** — names change (marriage, corrections) and
even a USTA number may be corrected — so edits must be **historized** (see
`PlayerHistory`).
| Field | Notes |
|-------|-------|
| `id` | PK (surrogate, stable; all FKs point here) |
| `usta_number` | unique business key; correctable, change tracked |
| `first_name`, `last_name` | mutable; change tracked |
| `birthdate` | optional, **stored**; could later *suggest* a division (suggestion still 🔭); the division actually played is per-roster |
| `updated_at` | timestamp of the current version (start of its validity) |

> Per-tournament attributes — **age division, selection status, t-shirt size,
> dietary preference** — live on `TournamentEntry`, not on `Player`, because they
> vary by tournament. This already covers **"became an adult"**: the division is
> whatever the roster row says for that tournament, so a player can be `B16` one
> year and an adult division the next with no change to `Player`.

### PlayerHistory  ✅ *built — append-only audit of player-level changes*
**SCD Type 4** (a separate history table), maintained automatically by a Postgres
trigger on `player` (migration `0004`). `Player` always holds the **current**
version; `PlayerHistory` holds every **past** version with a validity window. FKs
are unaffected (they still point at `player.id`), and current reads don't change.
The Player detail pane shows a **Name history** list.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `player_id` | FK → Player |
| `usta_number`, `first_name`, `last_name`, `birthdate` | the values **as they were** |
| `valid_from`, `valid_to` | `[valid_from, valid_to)` window this version was current |
| `change_type` | `update` \| `delete` |
| `changed_by` | optional (TD/user) |

Trigger sketch (no app code, can't be bypassed):
```sql
-- BEFORE UPDATE/DELETE on player: snapshot the OLD row, closing its window at now()
INSERT INTO player_history(player_id, usta_number, first_name, last_name,
                           birthdate, valid_from, valid_to, change_type)
VALUES (OLD.id, OLD.usta_number, OLD.first_name, OLD.last_name,
        OLD.birthdate, OLD.updated_at, now(), TG_OP);  -- 'UPDATE' | 'DELETE'
-- on UPDATE also set NEW.updated_at = now()
```

**Point-in-time name** (for stable historical reports) — resolve the name *as of* a
tournament's `play_start_date` by unioning history with the current row:
```sql
SELECT first_name, last_name FROM (
  SELECT first_name, last_name, valid_from, valid_to FROM player_history WHERE player_id = $1
  UNION ALL
  SELECT first_name, last_name, updated_at, 'infinity'::timestamptz FROM player WHERE id = $1
) v WHERE $as_of >= valid_from AND $as_of < valid_to;
```

**Roster name policy — point-in-time (policy A), implemented:**
1. **Point-in-time ✅ (chosen)** — roster/reports for a past tournament show the
   name as of its `play_start_date` via the query above; live screens show the
   current name. No duplication; always correct; reuses the history we already keep.
   *(Implemented in the roster `LATERAL` lookup.)*
2. **Snapshot-on-entry (not used)** — copy `first_name`/`last_name` onto
   `tournament_entry` when the player is added; trivial to read, but a later
   typo-fix won't propagate to old rosters.

> Alternatives considered: **SCD Type 2** on `player` itself (every version a row,
> `valid_to IS NULL` = current) — cleaner point-in-time queries but forces all FKs
> to reference an identity column instead of the version, more invasive; rejected
> for the POC. **Snapshot-only** (no history table) loses the cross-tournament
> change timeline the TD asked for.

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

### EmailMessage  ✅ *built (migration 0011)*
Provenance / review inbox (audit §4.3). Emails forwarded to the dedicated address
land here (POC: entered by hand). **No automated parsing** (D5 / audit §5.1): a
person sets `classification` and files each message into a list.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `message_id` | unique dedup key (nullable for manual adds) |
| `received_at`, `from_address`, `subject`, `body` | |
| `tournament_id` | FK (set by the reviewer) |
| `classification` | **human-assigned** text: `unclassified` \| `late_entry` \| `withdrawal` \| `doubles` \| `pairing_avoidance` \| `scheduling_avoidance` \| `division_flex` \| `hotel` \| `other` |
| `status` | `new` \| `filed` \| `needs_followup` (filing a list sets `filed`) |

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

### Withdrawal  ✅ *built (migration 0012)*
The email-driven withdrawal detail. Report columns (age division, player,
event(s), reason, notes — F2) come from this row joined to `TournamentEntry`.
Recording a withdrawal sets the roster `selection_status = withdrawn`.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | |
| `events` | event(s) withdrawn from |
| `reason` | **optional** when the player was an `alternate`; otherwise required — enforced at filing (audit §2.4) |
| `notes` | |
| `was_alternate` | **snapshotted at filing** (the roster flip to `withdrawn` would otherwise lose the prior status) |
| `source_email_id` | FK → EmailMessage (nullable); filing from an email marks it `filed`/`withdrawal` |

> `age_division` is read from `TournamentEntry` at list time. `was_alternate` is
> snapshotted here (not read back) because recording overwrites the roster status.

### LateEntry  ✅ *built (migration 0011)*
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | `player_id` carries the USTA number (F3 — no duplicate column) |
| `request_date`, `request_time` | when the late-entry email arrived |
| `age_division`, `events` | as requested in the email |
| `source_email_id` | FK → EmailMessage (nullable) |

> **Filing a late entry** (from the inbox or by hand) upserts the player by USTA
> number, puts them on the roster (`tournament_entry.source = late_entry`), and —
> when filed from an email — marks that email `status='filed'`,
> `classification='late_entry'`.

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

### SchedulingAvoidance (adults)  ✅ *built (migration 0013)*
Player↔day/time (audit §1.1). List + add + file-from-email.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | |
| `avoid_day`, `avoid_time_range` | |
| `source_email_id` | |

### DivisionFlexibility (adults)  ✅ *built (migration 0013)*
`willing_divisions` stored as a comma-separated string (POC). List + add + file-from-email.
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
`✅` built · `🔭` planned.
```
Site *───* Tournament  (M2M via tournament_site)                    ✅
Tournament *───* Assignment *───1 Official                          ✅
                    │  ├─ site_id → Site         (mileage venue)    ✅
                    │  ├─ room_block_id → RoomBlock                 ✅
                    │  └─* AssignmentDay (per-day role + rate)      ✅
Official *───* OfficialSiteDistance *───1 Site   (one-way miles)    ✅
CertificationRate (rate by cert type, per day)                      ✅
Hotel 1───* RoomBlock  (property vs. inventory; block→Tournament)   ✅
Official *───* Certification  (held certs)                          🔭
Tournament *───* Availability *───1 Official                        🔭

Tournament *───* TournamentEntry *───1 Player                       ✅
   (TD roster: selection_status, division, t-shirt, dietary; t-shirt history)

Part B (all 🔭): EmailMessage review inbox ──┬─ DoublesRequest → DoublesPair ← RandomPairingQueue
                                            ├─ Withdrawal      → sets TournamentEntry.selection_status
                                            ├─ LateEntry       → creates TournamentEntry (source=late_entry)
                                            ├─ PairingAvoidance *─* PairingAvoidanceMember (juniors)
                                            ├─ SchedulingAvoidance / DivisionFlexibility   (adults)
                                            └─ PlayerHotelStay → CVB analytics
All player rows ───* Player (key: usta_number); per-tournament attrs on TournamentEntry
```
