# Import page redesign — editable preview grid

Design + findings, 2026-06-28. **Status: shipped + verified.** Backend
edit/delete endpoints in `routers/imports.py` (tested in
`test_zz_import_export.py`); the preview grid is `_renderPreviewGrid()` in
`frontend/app.js` (replacing the old `_renderBatch` text summary). Verified live:
a roster upload with a missing-USTA row + a non-numeric-USTA row stages as
"1 ready, 2 to fix", merge is blocked, fixing the two cells in-grid revalidates
to "3 ready", and merge writes all three.

## Layout: one tab per import type

The page is a **tabbed layout** (`buildImportPage`): a left sidebar lists every
import type as a tab — grouped **Tournament data** then **Setup catalogs** (the
global ones that don't need an active tournament) — and the selected type's
panel (template downloads + upload + preview grid) shows on the right. Only one
import is visible at a time, so the page isn't a long scroll of 13 stacked
sections. The per-panel "⬆ Import…" deep-links (`gotoImport`) select the right
tab. Each section is `_buildImportSection()`; a scope chip on the heading marks
tournament-vs-Setup.

## Preview-grid bulk actions + richer validation

The preview grid's toolbar carries bulk fixes so a TD never has to round-trip to
Excel:
- **Merge ready rows** — merges only the rows that are server-valid AND
  client-clean, passing their ids (`POST /merge {row_ids}`). Flagged rows are
  **skipped, not blocking**, and stay staged; a partial merge does NOT seal the
  batch (it's only marked `merged` once no unmerged rows remain), so the leftover
  flagged rows stay editable/deletable.
- **Delete flagged** — drops every flagged row in one click
  (`POST /batches/{id}/rows-delete {ids}`).
- **Set a column for all** — bulk-fill one column across every staged row, then
  re-validate (`POST /batches/{id}/bulk-set {column, value}`), e.g.
  `age_division = G16` for a whole sheet.

The tab strip is horizontal with an **icon + short label** per type, a
**staged-count badge** while a batch is in progress (switch tabs without losing
it), and group separators (Tournament data | Setup catalogs). Validation adds a
cross-row **duplicate-USTA-in-file** check plus per-field rules (numeric money
columns, `year_of_birth`, `email` has `@`, division shape, the enums).

## Review of the current Import page

`buildImportPage()` (frontend/app.js) renders one section per import type:
template downloads (CSV/XLSX) → a file input → **Upload & stage** → a result
block rendered by `_renderBatch()`. Today that result is a **text summary**:
"Staged N: V valid, I invalid" + an `<ul>` of the first 50 row errors + Merge /
Discard buttons.

The backend already does the hard part: the upload endpoint stages every row into
`import_row` with a per-row `valid` flag and `error` string
(`routers/imports.py` + `importer.validate`). The merge only touches valid rows.

### Problems with the current UX
1. **No visibility into the data.** The TD uploads a file and sees only counts —
   they can't see *what* is in the file or which cell is wrong, only a row number
   and a message.
2. **No way to fix anything in-app.** A single bad cell (a typo'd USTA #, a blank
   reason, a non-numeric mileage) means: discard, fix the spreadsheet, re-upload.
   For a 100-row roster with two bad cells that's painful.
3. **Errors are detached from the data.** "row 7: player 2018… isn't in Setup" —
   the TD has to cross-reference row 7 back in Excel.

## Redesign — preview grid with inline validation

Replace the text summary with an **editable preview grid** (Tabulator) per
upload:

- **Columns = the import type's columns** (from `/api/import/types` → `columns` +
  `required`). Required columns are marked in the header.
- **One row per staged `import_row`.** Cells are editable in place.
- **A leading status cell** per row: ✓ valid / ⚠ invalid, with the error as a
  tooltip; invalid cells are tinted.
- **Automatic validation, two layers:**
  - *Client-side, instant* (`_IMPORT_VALIDATORS`): per-column rules that make
    sense for the data — required non-empty, USTA #/ids numeric, `one_way_miles`
    numeric ≥ 0, `gender` ∈ {male,female,m,f}, `wants_random` boolean-ish,
    `request_date` ISO-date-ish, relationship ∈ {siblings,same_club}. These run
    on render and on every edit, so the TD sees a problem the moment they type.
  - *Server-side, authoritative* (the existing `importer.validate`): cross-field
    + DB checks the client can't do (does this USTA # exist in Setup? is gender
    required because the player is new?). Re-run on every cell edit via a new
    `PATCH` endpoint; its `valid`/`error` is the source of truth for merge.
- **Live counts + a Merge button** that enables only when ≥1 row is valid and
  shows the current valid count; **Discard**; and per-row **delete** to drop junk
  rows (e.g. a stray totals line) without re-uploading.

### Backend additions (`routers/imports.py`)
- `GET /batches/{bid}` now returns each row's `id` (needed to address a row).
- `PATCH /batches/{bid}/rows/{row_id}` `{data}` → overwrite the staged row's
  data, re-run `importer.validate`, persist `valid`/`error`, and return the row +
  the batch's new aggregate `{total, valid, invalid}`. Refuses if the batch is
  already merged.
- `DELETE /batches/{bid}/rows/{row_id}` → drop one staged row; returns the new
  counts. Refuses on a merged batch.

These are additive — the upload/merge/discard endpoints are unchanged, so the
audit suite (`test_zz_import_export.py`) keeps passing, and new tests cover the
edit/revalidate/delete paths.

### Why edits live server-side (not just in the grid)
The merge reads `import_row` straight from the DB, so a fix must persist there or
it wouldn't survive to merge. Editing the staged row (and re-validating with the
same `validate()` the upload used) keeps a single source of truth and means the
grid's "valid" badge always matches what merge will actually accept.

## Validation rules per column (client layer)
| Column(s) | Rule |
|---|---|
| any `required` column | non-empty |
| `usta_number`, `partner_usta`, `usta_1..6`, `official_id`, `site_id`, `source_email_id` | digits only when present |
| `one_way_miles` | numeric, ≥ 0 |
| `gender` | ∈ {male, female, m, f} (case-insensitive) when present |
| `wants_random` | ∈ {yes,no,true,false,y,n,1,0,""} |
| `request_date` | `YYYY-MM-DD` when present |
| `relationship` | ∈ {siblings, same_club, ""} |
| `selection_status` | ∈ {selected, alternate, withdrawn, ""} |

The server still has the final say (USTA existence, reason-required-on-merge for
withdrawals, etc.); the client layer just front-runs the obvious mistakes.
