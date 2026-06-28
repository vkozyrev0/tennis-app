# Import / Export — audit findings & reuse checklist

Audit 2026-06-28. Every import and export surface was inventoried and verified
end-to-end against the real HTTP APIs with real fake CSV/XLSX/PDF files. The
regression net is `backend/tests/test_zz_import_export.py` (19 tests, all green).
Use this doc when adding a new import type or export so the same shapes/bugs
don't recur.

## Surface inventory

### Imports — staged pipeline (`routers/imports.py`, prefix `/api/import`)
`GET /types` → `GET /template/{type}?fmt=csv|xlsx` → `POST /tournaments/{tid}/{type}`
(multipart upload, parse+validate into `import_batch`/`import_row`) →
`GET /batches/{bid}` → `POST /batches/{bid}/merge` → `DELETE /batches/{bid}`.
The per-type registry (columns, aliases, required, merge fn) is
`app/importer.py::TYPES`. Twelve types:

| Type | Parse path | Notes |
|---|---|---|
| roster, roster_initial (B2a), roster_correction (B2b) | CSV/XLSX | roster types carry `gender`, so a new player is created at merge |
| late_entries, withdrawals, scheduling_avoidances, division_flexibility, player_hotels | CSV/XLSX | `_PLAYER` cols incl. gender; withdrawals need a `reason` unless the player was an alternate (enforced at MERGE, not staging) |
| pairing_avoidances | CSV/XLSX | wide format `usta_1..usta_6`; **no gender col → every USTA must already exist in Setup** |
| doubles_requests | CSV/XLSX | per-player; `partner_usta` must already exist; mutual rows auto-pair |
| distances | CSV/XLSX | **global Setup catalog** (tournament id ignored); match by ids or by labels |
| emails_pdf | PDF | document-shaped; `_parse_pdf_emails` returns canonical rows |

Direct (non-staged) import: `POST /api/tournaments/{tid}/players/import` (roster.py).

### Exports
| Export | Endpoint / source | Format |
|---|---|---|
| Payroll (bookkeeper) | `GET /api/tournaments/{tid}/payroll/export.csv` | CSV, **utf-8-sig BOM**, finalized records only |
| Assignment audit | `GET /api/tournaments/{tid}/assignment-audit.csv` | CSV (incl. deleted-assignment rows) |
| Official schedule | `GET /api/officials/{id}/schedule.ics` / `GET /api/me/schedule.ics` | iCalendar (RFC 5545, CRLF, all-day VEVENTs) |
| Roster grid | AG Grid `api.exportDataAsCsv()` | CSV (browser) |
| Print windows (statements, staffing, hotel, rooming, day-of) | `printDoc()` in app.js | browser print/PDF + companion `_csvDownload` |

## Findings

**Everything works.** All 12 import types stage + merge correctly across the CSV,
XLSX and PDF paths; templates download and round-trip; error handling is clean
(corrupt file → friendly 400, missing-required → staged-invalid with a message,
unknown USTA → staged-invalid naming the number, unknown type → 404); the CSV
exports carry the Excel BOM and the ICS export is well-formed. No functional bugs
were found — the audit converted the verification into the permanent test suite.

### Invariant worth protecting (now tested)
The **downloadable template must be self-importable**: `template_csv`/`template_xlsx`
emit canonical headers, and `parse_file` must recognize them, so re-uploading an
untouched template stages **0 rows, never a 400**. `test_every_template_downloads_
and_round_trips` enforces this for every type (CSV + XLSX). If you add a type,
this test covers it automatically.

### Known fragilities (not bugs — hardening backlog)
- **Encoding is lossy**: `parse_file` does `raw.decode("utf-8-sig", errors="replace")`
  — a UTF-16/Latin-1 upload silently becomes U+FFFD rather than being rejected.
- **Per-row USTA existence check**: `validate()` runs one `SELECT ... FROM player`
  per USTA-shaped field per row — fine for TD-sized files, O(N) round-trips for big
  ones. Batch-prefetch if imports ever get large.
- **PDF parse is format-specific**: `_parse_pdf_emails` assumes the USTA-portal
  Subject/Date/From/To block + footer markers; a portal layout change degrades it.
  Body is capped at 5000 chars.
- **Frontend print CSV** embeds data via `JSON.stringify` rather than a real CSV
  writer — fine today (controlled data) but not comma/newline-robust.

## Reuse checklist — adding a new import type
1. Add a `TYPES["x"]` entry: `cols` (Col with canon + aliases + required), a
   `merge(cur, tid, data)` that returns a conflict note or None, `label`, `desc`.
2. If the type can create a player, include a `gender` col (validate lets a new
   canonical `usta_number` through when gender is set); otherwise every USTA in
   the row must pre-exist in Setup.
3. Enforce business rules (like "reason required") inside `merge` (raise
   `ValueError`/`HTTPException`) — the batch isolates per-row failures via
   savepoints, so one bad row doesn't abort the rest.
4. It's automatically covered by the template round-trip + types-listing tests.
   Add a focused stage→merge test mirroring the ones in
   `test_zz_import_export.py` (build a real CSV/XLSX, assert valid count, merge,
   assert the row landed).

## Reuse checklist — adding a new CSV export
- Encode `utf-8-sig` (BOM) so Excel opens it without mojibake; set
  `Content-Disposition: attachment; filename=...`; `media_type="text/csv"`.
- Return a header row even when there are zero data rows (don't 500 on empty).
- Add a test asserting 200 + `text/csv` + the BOM + the header line.
