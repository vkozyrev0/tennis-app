# Performance notes

Findings + fixes from the performance audit (2026-06-27), and the patterns to
reuse when building similar subsystems. The app is a sync FastAPI + psycopg3
backend (one connection per request) and a no-build vanilla-JS + AG Grid
frontend, so the wins are about **round-trips and per-row work**, not threads.

## Backend

### Fixed — N+1 `_summary()` fan-out → batch `_summaries()`
`routers/assignments.py`. `_summary(cur, a)` issues **5 queries per assignment**
(days, certs, site distance, cross-tournament bookings, availability). It was
called in a Python loop by the payroll summary, officials report, pay-statement,
conflict, `me` schedule, and per-official overview endpoints — so a 40-official
tournament fired ~200 sequential round-trips per request.

**Fix:** `_summaries(cur, assignments)` loads every input in **5 set-based
queries** keyed by `assignment_id = ANY(%s)` / `official_id = ANY(%s)`, groups
them in Python, and calls the unchanged pure `compute_summary()` per assignment.
~5·N queries → 5. Wired into `payroll_summary`, `list_assignments`,
`pay_summary`, the pay-statement builders, `assignment_conflicts`,
`officials_report`, and `me` schedule. Validated by the existing payroll/report/
assignment suite (identical output — `compute_summary` is pure, only the
data-loading layer changed).

**Reuse this pattern** for any endpoint that decorates N rows with per-row
lookups: fetch the parent rows, collect the keys, run one `WHERE key = ANY(%s)`
per related table, group into dicts (`defaultdict(list)` / by-id maps), then
assemble in Python. Never put `cur.execute` inside a row loop. The dashboard
digest (`routers/dashboard.py`) is already a good model — 5 `GROUP BY` queries +
Python assembly, no per-row SQL.

### Fixed — inbox detected-text stamp (D9, 2026-07-19)
Migration **0051** adds `detected_reason` / `detected_division` /
`detected_events` / `detected_name_pairs` / `detected_avoid_day` /
`detected_avoid_time` + `detected_text_ready`. Pure
`email_extract.compute_extracted_fields` runs on create / update / detect /
bulk-classify / ingest / PDF import; list GETs **read columns** and only
lazy-stamp when `detected_text_ready` is false (legacy rows). Body is still
decrypted for the detail pane. Search also matches classification, division,
and player name. Frontend inbox scopes to the active tournament and shows
`X-Total-Count` ("N of M").

### Known follow-ups (not yet done)
- **`payroll.finalize_all` / `assignment_invite_texts`** still loop the single
  `_summary`; batch them with `_summaries` (and `executemany` the inserts).

## Frontend

### Fixed
- **O(n) roster scan → O(1) index.** `_rowGender` did
  `Object.values(playersById).find(x => x.usta_number === …)` on every editor
  open. Added a `playersByUsta` map (rebuilt alongside `playersById`) — O(1)
  lookup. **Reuse:** keep a secondary index for every key you look *up* by, not
  just the primary id.
- **Memoized the player picker list.** `_playerPickValues()` re-sorted the whole
  roster (`localeCompare`) on every cell-editor open; now cached and invalidated
  (`_invalidatePickCache`) only when `playersById` is rebuilt.
- **De-duplicated formatter work.** `_inboxNameCell` computed `_inboxSlots(m)`
  twice per render; now once, reused.

### Known follow-ups
- Several setup/roster grids re-fetch and `setData()` the **whole table** after a
  single-cell inline edit (`app/grids.js` `cellEdited` → `refresh()`,
  `loadRoster()`); prefer `cell.getRow().update(savedRow)` and keep the full
  reload only for the error/rollback path.
- `app/grids.js::matchesFilter` re-runs each column's `fmt(data)` for every row
  on every keystroke; precompute a lowercased search haystack per row at load.

### Verified clean (don't chase)
- No `JSON.parse(JSON.stringify())` / `structuredClone` deep-clone hot paths.
- No repeated `JSON.parse` of the same payload in loops/formatters.
- All backend regexes are module-level compiled (no per-call compilation).
- The dashboard's render fns are already fire-and-forget (run concurrently).
