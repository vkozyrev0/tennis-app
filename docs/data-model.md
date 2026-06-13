# CourtOps Tennis — Data Model

Proposed entities derived from the vision, with the collisions from
[audit.md](audit.md) already resolved (e.g., split avoidances, split hotels).
Storage-agnostic; field types are indicative. **PK** = primary key,
**FK** = foreign key.

> **Build status (POC):** ✅ implemented · 🔭 planned (designed, not yet built).
> **Part A is fully implemented** (incl. Certification + Availability) and
> **Part B (player operations) is now fully implemented** as a human-review
> workflow — review inbox + all lists (late entries, withdrawals, scheduling
> avoidances, division flexibility, pairing avoidances, doubles, player hotels,
> t-shirts). Markers below call out where the model and the running app differ.
> The **P4 day-of-operations series** also shipped: day-of operations
> (actual-status, incidents, audit trail), **payroll finalization** (freeze pay
> at event close + mark-paid + CSV export), and scoped **soft-delete**
> (tournaments + incidents Trash/restore).

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
| `deleted_at` | timestamptz, NULL = active (migration 0046 soft-delete) |

> **Soft-delete (migration 0046)** is scoped to **Tournament and
> TournamentIncident only** — *not* players/officials/emails, where delete is a
> COPPA PII-erasure and stays hard-delete. Lists filter `deleted_at IS NULL`;
> trashed rows appear in a **Trash** list and can be **restored**. Backed by
> partial indexes `idx_tournament_active` / `idx_incident_active`.

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
| `source` | `geocoded` \| `manual` \| `maps` (migration 0047; `maps` = Google Distance Matrix driving distance when `GOOGLE_MAPS_API_KEY` is set) |

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
| `cert_type` | one of 5: `roving_official` \| `chair_umpire` \| `tournament_referee` \| `deputy_referee` \| `referee_in_training` |

### CertificationRate
Set by TD; **per-day** rate by certification type (D2). The applicable rate is
chosen per day by `AssignmentDay.working_as`, so an official can be paid different
rates on days they work different roles (audit §3.2).
| Field | Notes |
|-------|-------|
| `id` | PK |
| `cert_type` | one of 5: `roving_official` \| `chair_umpire` \| `tournament_referee` \| `deputy_referee` \| `referee_in_training` |
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

## Part B — Player operations  ✅ *lists complete*
> **Built:** the **`EmailMessage` review inbox** + every list with a generic
> "file from email" picker — late entries, withdrawals, scheduling avoidances,
> division flexibility, player hotel stays (+ CVB analytics), pairing avoidances
> (groups), the cumulative t-shirt list, and **doubles** (mutual two-sided
> verification + random FIFO queue). Human-review workflow, no auto-parsing
> (D5/§5.1). Future enhancement: a triage agent that auto-suggests classification.

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
| `gender` | **required** `male`/`female`; drives the gender-aware division/event picker (migrations 0025 + 0026) |
| `birthdate` | optional at the API boundary; required on the Setup-page form (inline-create from roster/inbox flows may upsert without it) |
| `city`, `state` | optional address-of-record (migration 0019) |
| `updated_at` | timestamp of the current version; sent back as `X-If-Updated-At` for optimistic concurrency on PUT |

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

> **Triage agent v0 (built):** `POST /api/emails/{id}/suggest` returns a
> rule-based classification (`app/triage.py`) — local keyword matching, **no LLM /
> no data leaves the building** (D5-safe); the inbox "Suggest" button applies it and
> a human confirms. Upgrading to an **LLM** that reads email content is the still-
> open **D5** call (cloud vs local).
>
> Player auto-detection persists onto this row — see **EmailMessage detection
> columns** (migrations 0030/0031/0039/0041/0042) at the bottom of this doc.

### DoublesRequest  /  DoublesPair  ✅ *built (migration 0016)*
Two-sided verification (audit §2.2).
- **doubles_request** (one filed email): `id`, `tournament_id`, `age_division`,
  `player_id` (requester), `partner_usta` (named partner; null for random),
  `wants_random` (bool), `status` (`pending` \| `paired`), `source_email_id`.
- **doubles_pair** (verified): `id`, `tournament_id`, `age_division`, `player1_id`,
  `player2_id`, `pairing_type` (`mutual` \| `random`), `verified`.

> **Mutual** verifies when filing a request finds a reciprocal pending request
> (the named partner named this player back, same division) → a `doubles_pair`
> (`mutual`) is created and both requests flip to `paired`. **Names** resolve via
> `concat_ws` so a missing first/last doesn't blank the row.

### RandomPairingQueue  ✅ *built — implemented as pending random `doubles_request` rows*
No separate table: a **random** request is a `doubles_request` with
`wants_random=true`. The pending ones, ordered by `created_at`, **are** the FIFO
queue per `(tournament, age_division)`.

**Rules (§3.6):** filing a random request pairs it with the oldest pending random
request in the same division → a `doubles_pair` (`pairing_type=random`); both flip
to `paired`. An odd requester stays `pending` (waiting). Binding: once filed, a
player plays with whoever is randomly assigned.

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

### PairingAvoidance (juniors)  ✅ *built (migration 0015)*
A group of **two or more** players who must not meet in the **first round**
(audit §1.1; confirmed C1 — same club or siblings). Modeled as a header +
members so a group can exceed two players.
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `age_division` | |
| `relationship` | `same_club` \| `siblings` |
| `source_email_id` | |

### PairingAvoidanceMember  ✅ *built (migration 0015)*
The players in a `PairingAvoidance` group (2+ rows per group). UI: dynamic member
rows (+member); list shows the names joined ("A & B & C").
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

### PlayerHotelStay  (CVB sponsorship analytics — audit §1.2)  ✅ *built (migration 0014)*
Players report which hotel they stayed in so the TD can show room-night patterns
to the CVB and earn complimentary officials' rooms / sponsorship (confirmed C2).
List + add + file-from-email; `GET /api/hotel-analytics` aggregates stays per hotel
across all tournaments (shown as "CVB hotel totals").
| Field | Notes |
|-------|-------|
| `id` | PK |
| `tournament_id`, `player_id` | |
| `hotel_name` | free-text, normalize for analytics |
| `source_email_id` | |

### T-shirt size  (cumulative history — F1, carried by `TournamentEntry`)  ✅ *built*
Not a separate table: `TournamentEntry.t_shirt_size` already gives one row per
player per tournament, so the set of a player's entries **is** the cumulative
history. "Latest size" = derived view, the most recent entry by tournament date.
This keeps a player's most recent size known even when they are a late entry in a
future tournament (late entries never pick a size on the USTA site; the TD records
it on their `TournamentEntry`, `source = late_entry`). F1 satisfied — history
kept, not collapsed. Surfaced via `GET /api/tshirts` (a derived cross-tournament
list) on the **T-shirts** Setup tab.

### TshirtOrder  ✅ *built (migration 0024)*
Per-tournament inventory + order snapshot tracking. Lets the TD enter on-hand
counts per size, then "Place order" snapshots today's *requested* counts
(derived from selected players' `t_shirt_size`). After that, withdrawals + late
entries shift `requested` live while `snapshot` shows what was actually
ordered.
| Field | Notes |
|-------|-------|
| `tournament_id` | PK · FK → Tournament |
| `ordered_at` | date the order was placed (NULL = no order yet) |
| `on_hand` | JSON map of `{size_code: count}`, sparse (TD-edited sizes only) |
| `snapshot` | JSON map of `{size_code: requested_at_order_time}` |

Canonical size codes: `YS YM YL AS AM AL AXL` (shared with the importer's
`norm_shirt`). Surfaced at the **Tournament → T-shirts** tab.

### Division + TournamentEvent  ✅ *built (migration 0027)*
Configurable catalogs that replaced hardcoded division/event constants.
Filterable by `tournament_type` (junior/adult) and `gender` (NULL means
"any") so the roster picker shows the right list. Editable from
**Setup → Divisions / Events**.
| Table | Fields |
|-------|--------|
| `division` | `id`, `code` (unique), `label`, `tournament_type`, `gender` (nullable), `sort_order` |
| `tournament_event` | `id`, `name` (unique), `tournament_type`, `gender` (nullable), `sort_order` |

Seed populates 26 divisions (10 junior B/G10..18 + 16 adult NTRP + Combo) +
7 events (Singles/Doubles juniors + Men's/Women's/Mixed Singles/Doubles).

### ImportBatch / ImportRow  ✅ *built (migration 0020)*
Staged-import pipeline (parse → validate → review → merge). A TD uploads a
CSV/XLSX file via **Data → Import**; rows are parsed + per-row validated and
land in `import_row` first. After the review summary, valid rows merge into
the main tables; failed/conflict rows are surfaced with row-level errors.
| Table | Fields |
|-------|--------|
| `import_batch` | `id`, `tournament_id`, `import_type`, `filename`, `status` (`staged`/`merged`/`discarded`), `created_at` |
| `import_row` | `id`, `batch_id` (FK), `row_num`, `data` (JSON), `valid`, `error`, `merged` |

Registered import types (`importer.TYPES`, audit-resolved circular dep):
- **Setup catalog**: `distances` (resolves official + site by id OR label)
- **Roster**: `roster` (direct-merge endpoint also routes through this)
- **Part B**: `late_entries`, `withdrawals`, `scheduling_avoidances`,
  `division_flexibility`, `player_hotels`
- **Wide-format**: `pairing_avoidances` (usta_1..usta_6 + division +
  relationship), `doubles_requests` (mutual sides pair automatically when
  both rows land in the same batch)

Every type has CSV + XLSX templates auto-generated from the column
declarations and a parametrized round-trip smoke test.

### PlayerHotelStay (additions since 0016)  ✅
Migration 0018 added `lodging_plan` (Hotel / Commuter / At another's house /
…); 0023 added `hotel_id` FK so the canonical hotel name is referenced, not
free-text-duplicated.

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
Official *───* Certification  (held certs)                          ✅
Tournament *───* Availability *───1 Official                        ✅

Tournament *───* TournamentEntry *───1 Player                       ✅
   (TD roster: selection_status, division, t-shirt, dietary; t-shirt history)

Part B (all ✅): EmailMessage review inbox ──┬─ DoublesRequest → DoublesPair ← RandomPairingQueue
                                            ├─ Withdrawal      → sets TournamentEntry.selection_status
                                            ├─ LateEntry       → creates TournamentEntry (source=late_entry)
                                            ├─ PairingAvoidance *─* PairingAvoidanceMember (juniors)
                                            ├─ SchedulingAvoidance / DivisionFlexibility   (adults)
                                            └─ PlayerHotelStay → CVB analytics
All player rows ───* Player (key: usta_number); per-tournament attrs on TournamentEntry
```

---

## Backlog B1/B2/B3 schema additions (migrations 0028 + 0029)

### Player catalog extensions (migration 0028)
The USTA "Full Player Data" Excel export carries more than the original
schema tracked. These columns are all NULLable so existing data + flows stay
valid; the **`roster_initial`** importer populates them via upsert.

| Column | Type | What |
|--------|------|------|
| `emails` | TEXT | comma-separated list (USTA exports multiple) |
| `phones` | TEXT | comma-separated list |
| `district` | TEXT | e.g. "North Carolina" |
| `section` | TEXT | e.g. "Southern" |
| `wtn_singles` | NUMERIC(5,2) | World Tennis Number — singles |
| `wtn_singles_conf` | TEXT | "High degree" / "Medium" / etc. |
| `wtn_doubles` | NUMERIC(5,2) | WTN — doubles |
| `wtn_doubles_conf` | TEXT | confidence label |
| `birthdate_precision` | TEXT NOT NULL DEFAULT 'day' CHECK IN ('day','year') | Initial import only carries year-of-birth → store as `YYYY-01-01` with precision='year' |

### Roster (tournament_entry) extensions (migration 0028)

| Column | Type | From |
|--------|------|------|
| `payment_status` | TEXT | B2a — "PAID" / "NOT_REQUIRED" / etc. |
| `amount_paid` / `amount_refunded` / `amount_due` / `amount_outstanding` | NUMERIC(8,2) | B2a |
| `card_stored` | BOOL | B2a — "Card stored" Y/N |
| `signed_in` | BOOL NOT NULL DEFAULT false | B2b — "Tournament sign in" cell |
| `suspension_points` | INT | B2b — per-tournament (see migration 0028 comment for placement rationale) |
| `lodging_plan` | TEXT | B3 — parsed canonical ("Hotel" / "Local / family" / "Commuter" variants) |
| `lodging_plan_raw` | TEXT | B3 — raw fallback for unmappable hotel answers |

### B1 — Division ↔ site assignment (migration 0029)
`tournament_site_division (tournament_id, site_id, division_id)` with
**UNIQUE (tournament_id, division_id)** — one division can only sit at one
site per tournament (questionnaire 1.1). Drives the per-site t-shirt report.

API endpoints (existing tournaments router):
- `GET /api/tournaments/{id}/site-divisions` — full matrix
- `PUT /api/tournaments/{id}/site-divisions/{division_id}` body `{site_id|null}`
- `GET /api/tournaments/{id}/tshirts-by-site` — grouped roster ("Unassigned" bucket)

### Importer registry (after B2 + B3)

| Key | Purpose | Status |
|-----|---------|--------|
| `roster` | Simple ad-hoc roster (4-5 cols, hand-typed). | Legacy — kept for backward compat |
| `roster_initial` | **B2a** USTA "Full Player Data" Excel. Catalog + roster + payment snapshot. | Production |
| `roster_correction` | **B2b** USTA "Updated Status" CSV. Surgical status/division/events/sign-in patches; late-adds. | Production |
| `tshirt_hotel_dietary` | **B3** Combined T-shirt + Hotel-question + Dietary, one row per player. | Production |
| `player_hotels` | Specific hotel-name + lodging (FK to `hotel`); drives CVB analytics. | Distinct from B3 — coexists |
| `late_entries` / `withdrawals` / `scheduling_avoidances` / `division_flexibility` / `pairing_avoidances` / `doubles_requests` | Per-list inbox flows | Unchanged |
| `emails_pdf` | Tournament-emails **PDF** (pdfplumber) → parsed/staged email rows for the inbox. | Production |
| `distances` | Setup catalog (global, not per-tournament). | Unchanged |

---

## Day-of operations + inbox detection (migrations 0040–0048)

### AssignmentDay.actual_status (migration 0040)  ✅ *day-of truth*
Planned-vs-actual per assignment day (P4-1). The TD marks what really happened
on the day; `no_show` days **drop out of pay**, the rest is reporting truth
(who actually worked) for payroll reconciliation.
| Column | Notes |
|--------|-------|
| `actual_status` | TEXT NOT NULL DEFAULT `'planned'` CHECK IN (`planned`, `worked`, `no_show`, `early_departure`) |

> Player day-of check-in is **not** part of 0040 — the roster's `signed_in`
> flag (migration 0028, B2b) already covers the player side; 0040 touches
> `assignment_day` only.

### EmailMessage detection columns (migrations 0030/0031/0039 + 0041 + 0042)  ✅
Auto-detection writes its result onto the email row so the inbox grid and the
filing flows can read it back. Earlier additions: `detected_player_id`
(0030, FK → Player — the primary detected player), `detected_match_kind`
(0031 — *why* it matched, `manual` when hand-picked), `detected_usta_text`
(0039 — the USTA # parsed from the text, persisted so it's server-side
searchable despite body encryption). New:
| Column | Migration | Notes |
|--------|-----------|-------|
| `detected_partner_id` | 0041 | INT FK → Player, ON DELETE SET NULL. **Doubles**: the detected partner (second player) — the detector re-runs the layered match with the primary excluded. NULL for other classifications (auto-fill; a manual partner persists). |
| `detected_member_ids` | 0042 | INT[]. **Pairing-avoidance groups**: ALL detected players, primary first (the detector loops, excluding everyone found so far, cap 6), so the inbox shows the whole group and filing pre-fills every member row. NULL otherwise. |

### TournamentIncident  ✅ *built (migration 0043)*
Day-of incident log (P4-3) — the tournament's operational memory. Weather
delays, injuries, disputes, facility problems get logged as they happen (quick
one-liner), optionally resolved later; feeds post-event review and
protest/dispute paper trails. Tournament-scoped
(`/api/tournaments/{id}/incidents`).
| Field | Notes |
|-------|-------|
| `id` | PK (identity) |
| `tournament_id` | FK → Tournament, ON DELETE CASCADE |
| `site_id` | FK → Site (nullable), ON DELETE SET NULL |
| `occurred_at` | timestamptz, default now() |
| `category` | `weather` \| `injury` \| `dispute` \| `facility` \| `conduct` \| `other` |
| `severity` | `info` (default) \| `minor` \| `major` |
| `description` | required one-liner |
| `resolved`, `resolution` | bool (default false) + optional resolution text |
| `created_at` | timestamptz |
| `deleted_at` | timestamptz, NULL = active (migration 0046 soft-delete) |

Indexed on `(tournament_id, occurred_at DESC)`.

### AssignmentAudit  ✅ *built (migration 0044)*
**Append-only** assignment change trail (P4-5): WHO changed an assignment,
WHEN, and WHAT — the dispute-resolution record `pay_audit` doesn't cover (that
freezes *amounts*, not *actions*). `assignment_id` is SET NULL on delete and
the tournament/official identity is **denormalized**, so the trail survives
the assignment itself being removed.
| Field | Notes |
|-------|-------|
| `id` | PK (identity) |
| `assignment_id` | FK → Assignment (nullable), ON DELETE SET NULL |
| `tournament_id`, `official_id`, `official_name` | denormalized identity (no FKs) — survives deletes |
| `changed_at` | timestamptz, default now() |
| `changed_by` | required (the logged-in user) |
| `action` | `created` \| `updated` \| `deleted` \| `day_added` \| `day_removed` \| `day_status` \| `response` \| `finalized` \| `unfinalized` \| `paid` \| `unpaid` *(payroll lifecycle, 0045)* |
| `detail` | jsonb — the change payload |

Indexed on `(assignment_id, changed_at DESC)` and
`(tournament_id, changed_at DESC)`.

### PayrollRecord  ✅ *built (migration 0045)*
**One immutable record per assignment**, written when payroll is **finalized**
at event close (P4-4). It **freezes the computed pay** — per-day cert rates were
already snapshotted onto `assignment_day` — so later edits to days, rates,
distances, or no-show flags can't move money already approved for payment.
Identity is **denormalized** and the FK is `ON DELETE SET NULL`, so the money
trail survives the assignment itself being removed (same policy as
`assignment_audit`).
| Field | Notes |
|-------|-------|
| `id` | PK (identity) |
| `assignment_id` | **UNIQUE** FK → Assignment (nullable), ON DELETE SET NULL — one per assignment |
| `tournament_id` | INT NOT NULL |
| `official_id` | INT (denormalized) |
| `official_name` | TEXT NOT NULL — denormalized identity, survives assignment deletion |
| `days_worked` | INT NOT NULL |
| `no_show_days` | INT NOT NULL, default 0 |
| `pay` | numeric(10,2) NOT NULL |
| `mileage` | numeric(10,2), NULL = no distance on file at finalize time |
| `total` | numeric(10,2) NOT NULL |
| `rule_version` | TEXT |
| `detail` | jsonb NOT NULL — frozen day-by-day breakdown |
| `finalized_at` | timestamptz NOT NULL, default now() |
| `finalized_by` | TEXT NOT NULL |
| `paid` | boolean NOT NULL, default false |
| `paid_at` | date — meaningful only when `paid` |
| `paid_method` | TEXT, CHECK IN (`check`, `ach`, `cash`, `venmo`, `zelle`, `other`) |
| `paid_note` | TEXT |
| `batch_id` | INT FK → PaymentBatch (nullable), ON DELETE SET NULL (migration 0048) — the batch this record was settled in, if any |

Indexed on `(tournament_id)` (`idx_payroll_tournament`) and `(batch_id)` (`idx_payroll_batch`).

### PaymentBatch  ✅ *built (migration 0048)*
A group settlement — a check run, an ACH file, a cash day — that pays several
finalized `payroll_record`s at once. Creating a batch marks every member paid
with one shared method/date/reference; dissolving it walks every member back to
unpaid (the records stay *finalized* — the FK is `ON DELETE SET NULL`, so the
money rows survive the batch). Tournament-scoped.
| Field | Notes |
|-------|-------|
| `id` | PK (identity) |
| `tournament_id` | FK → Tournament, ON DELETE CASCADE |
| `reference` | TEXT NOT NULL — e.g. "Check run 2026-06-15", "ACH #42" |
| `method` | TEXT NOT NULL, CHECK IN (`check`, `ach`, `cash`, `venmo`, `zelle`, `other`) |
| `paid_on` | date NOT NULL |
| `note` | TEXT |
| `created_by` | TEXT NOT NULL |
| `created_at` | timestamptz NOT NULL, default now() |

Indexed on `(tournament_id)` (`idx_payment_batch_tournament`).
