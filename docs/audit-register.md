# CourtOps — Living Audit Register

Open findings from code/security/UX audits **after** the original TD-vision
audit (`audit.md`, archived 2026-05-27). Use this for work still in flight.

**Status:** ⬜ open · 🔄 in progress · ✅ resolved · ⏸️ deferred (explicit)

Severity: **H** high · **M** medium · **L** low

> **Product posture (updated 2026-10-17):** still a POC; inbox triage/filing is
> the main day-to-day pain. Mail arrives by paste, PDF import, the ingest
> webhook, **Gmail IMAP**, or **Outlook Graph**; a human still files every row.
> (The 2026-07-21 note said manual paste only; that is no longer true.)
> Hardening pass closed MultiFernet, export/view audit, COPPA gate, CSP headers,
> session/password defaults, official tournament scoping, and dep pins.

---

## Open

| ID | Finding | Sev | Notes |
|----|---------|-----|-------|

| D13 | No DB connection pool | ⏸️ | Trigger: multi-worker / multi-instance |
| D14 | Login throttle process-local | ⏸️ | Trigger: multi-instance |
| D18 | CSRF not explicit | ⏸️ | **Deferred:** cookie is `SameSite=Strict` + SPA is same-origin only; add CSRF tokens if cross-site clients or non-browser consumers appear |
| D20 | API PII views are not all audited; `can_export_pii=false` only gates CSV bytes | M | Player 360 logs `access_audit`, but `GET /api/players` / `/{id}` and email-body reads do not; an admin with the flag off can still read contact PII via curl. Decide: redact those responses, log them, or accept as TD back-office access. |
| D22 | Login throttle keys on `(proxy IP, username)` | M | Random usernames bypass the per-key cap, and behind Fly/Render every client shares the proxy IP, so five bad guesses can lock out `admin`. Add a global per-IP cap and set trusted proxy headers. |
| D23 | Feed cursor advances past failed messages | L | Gmail/Outlook write `last_uid`/`last_received_at` even when rows errored, and the `last_status='error'` write is rolled back. Advance only past successes and persist the error separately. |
| D24 | Deleting a withdrawal/late entry leaves its roster side effect | L | The delete removes the row but the roster stays `withdrawn` or keeps the inserted entry. Restore the prior status/remove the sourced row. |
| D25 | Server-local dates for day-of/deadlines/retention | L | `date.today()` / `CURRENT_DATE` on a UTC container is off by one for US evenings. Use a configured venue timezone. |
| D26 | Deploy hygiene | L | No `pg_advisory_lock` around migrations, base images/GGUF not digest/checksum pinned, and the Caddy example omits `ENV=prod`. |
| D27 | Room-block and payment-batch check-then-act | L | Capacity/payment checks read then write without `FOR UPDATE`; two admins can overbook or double-batch. |
| D28 | LLM corpus tests skip in CI | L | The sidecar-dependent corpus suites skip unless a local llama.cpp answers on :8080; CI has no sidecar. Record responses or add a sidecar job. |
| D30 | `require_export_pii` has no production caller | L | Defined in `security.py`, used only by a coverage test; live CSV routes use `require_admin`. Wire it into the minors-PII server CSV routes or delete it and its test. |
| D31 | No test that a self-service password change kills other sessions | L | `auth.change_password` deletes other sessions; the suite checks the current session only. Add a two-session test. |
| D32 | Login-enumeration test is timing-based | L | `test_zz_login_enum.py` asserts a wall-clock ratio. Monkeypatch `verify_pw` and assert the dummy-hash path instead. |
| D33 | Query-ceiling test depends on accumulated rows | L | `test_zz_contracts.py` asserts `<= 6` queries against the shared inbox; scope it to a fresh tournament. |
| D34 | 44 of 62 frontend modules have no direct test | L | `util`, `export_csv`, and `print` now have tests; the rest (including `auth.js`, `state.js`, `grids.js`) rely on the browser smoke. Add focused unit tests as the modules change. |
| D35 | Test-pattern debt | L | Skip-masking setup, conditional assertion blocks, source-text assertions, and a config-reload test that creates divergent `settings` objects remain in the coverage-only suites (`test_zz_coverage_*`, `test_zz_pdf_leftover_llm`, `test_zz_unit_coverage`). |


## Resolved (this register)

| ID | Finding | Resolved |
|----|---------|----------|
| H4.2 / A4 | Bulk minors-PII CSV ungated | ✅ 2026-07-20 — `can_export_pii` + confirm; `export_gate.py`; SPA gate |
| D19 | Full PII *view* audit (not just export) | ✅ 2026-07-21 — `access_audit` + log on player 360; `GET /api/access-audit` |
| D10 | `finalize_all` / invite-texts N×`_summary` | ✅ 2026-07-21 — both use `_summaries` (5 set queries) |
| D17 | No CSP / security headers on app | ✅ 2026-07-21 — middleware CSP + nosniff/frame/referrer/COOP; HSTS in prod |
| D3 | 30-day sessions + default `admin/admin` | ✅ 2026-07-21 — prod session default 7d; `must_change_password` + prod API gate; SPA force modal |
| D8 | Officials can list all tournaments | ✅ 2026-07-21 — `/me/tournaments` + availability scoped to assignment / prior avail / open events |
| D11 | `frontend/app.js` monolith; mixed `innerHTML` | ✅ 2026-07-21 — composition root ~760 LOC; ~50 ESM modules under `frontend/app/`; residual raw `innerHTML` only where grids/print require it |
| D15 | Docs drift (suite counts, PII plan §3, design tree) | ✅ 2026-07-21; re-synced 2026-07-29 — ~591 / 89 / 0055; stale 528 + 0049 fixed; open-work D4. Re-synced 2026-09-21 — current-status lines then said 985 / 112 / 0060. Re-synced again **2026-10-17** — 1065 tests / 114 files / 0060, 62 frontend modules, 930 app.js lines, 25 frontend test files. Historical changelog/review counts keep the date they were written. |
| D16 | Residual plaintext / under-13 without policy | ✅ 2026-07-20 — `docs/coppa-policy.md`; `ALLOW_UNDER13_PII` gate; `GET /api/coppa/policy` |
| D2 | Fernet key rotation not operational | ✅ 2026-07-20 — MultiFernet + `PII_ENCRYPTION_KEYS` + `reencrypt_pii.py` |
| D4 | Ingest allows `?token=` | ✅ 2026-07-20 — refused when `ENV` is prod unless `INGEST_ALLOW_QUERY_TOKEN=1` |
| D21 | Bulk "Populate lists" re-filed an already-filed email | ✅ 2026-10-17 — `bulk_populate` now skips rows whose `status` is `filed`; a distinct second email for the same player is still its own row by design. |
| D29 | Dead Tabulator comments/rules + unreachable export scrape | ✅ 2026-10-17 — removed the dead `.tabulator` CSS, converted the editable-cell/action selectors to `.ag-cell`, and deleted the unreachable `EXPORTABLE` table scrape in `export_wiring.js`. |
| D12 | Unpinned `requirements.txt` | ✅ 2026-07-20 — version bounds + `requirements.lock`. Lock regenerated 2026-10-17 (the old one could not resolve) and CI now dry-run-resolves it. |
| D5 | Assignment `site_id` not tournament-scoped (API) | ✅ 2026-07-19 — `_check_assignment_refs` on create/update/bulk |
| D6 | Assignment `room_block_id` not tournament-scoped (API) | ✅ 2026-07-19 — same helper |
| D9 | Inbox list re-ran extractors per row | ✅ 2026-07-19 — migration 0051 stamp + column reads; search/paging UX |
| E1 | Day-of defaults to today outside play window (empty venue) | ✅ 2026-07-19 — default/snap to play_start; "Jump to play start" |
| E2 | Official profile Save wiped lat/lng (no form fields) | ✅ 2026-07-19 — cache geo from /me and re-send on PUT |
| D1 | No export audit log | ✅ 2026-07-19 — migration 0052 + POST/GET /api/export-audit; SPA `_csvDownload` logs client CSVs |
| — | Day-of L1 left previous panel on screen | ✅ 2026-07-19 — `activateGroup` always activates a tab |
| — | Email auto-ingest app side (D4) | ✅ 2026-07-19 — migration 0050 + webhook; provider wiring still external |
| B1 | `Secure` cookie only via env flag | ✅ 2026-07-20 — auto-on when `ENV` is prod; explicit override still wins |
| F2 | `esc()` omitted quotes | ✅ 2026-07-20 — `"` / `'` escaped; html unit test extended |

## 2026-10-17 audit pass — fixed in this pass

App-wide audit (backend, frontend, tests, docs, presentation surfaces). The
open items above are the deferrals; these shipped:

- **PII at rest:** import staging encrypts contact/DOB values and clears a row
  after merge; retention deletes old staged batches and redacts
  `to_address` + the `detected_*` PII fields; deleting a player also redacts
  linked email rows and promoted inbox people; rotation now includes
  `player_history.birthdate` and the Gmail/Outlook mailbox secrets.
- **Boot/release guards:** a malformed `PII_ENCRYPTION_KEY` fails `ENV=prod`
  boot; `requirements.lock` was regenerated and CI dry-run-resolves it; the
  health endpoint returns 503 when the DB is down and no longer leaks the raw
  DB error.
- **API correctness:** player create/update persist and encrypt the extended
  catalog fields; an official's self-service profile can no longer rewrite
  `lat/lng` (mileage); `imap_host` is restricted to Gmail; server CSVs
  neutralize formula cells; API bodies are capped at 25 MB; the player PUT
  carries an atomic `updated_at` predicate; a stale ingest default falls back
  to unscoped mail; DSNs are quoted and bounded; ICS filenames/CRs are safe.
- **Frontend:** closed the print-window and mobile-expander XSS sinks, the CSV
  formula gap, and the roster export path that bypassed the audit/PII gate;
  fixed list filters, the number editor, typeahead keyboard, cell-error styles,
  session-expiry cleanup, the notices leak, modal focus, loader races/error
  states, import deep links/discard confirm, payroll validation, alternates on
  a division-less withdrawal, chat confirm re-entry, the password prompt, and
  dark-mode warning contrast.
- **Tests:** each pytest process uses its own DB; added an auth matrix, cookie/
  logout assertions, COPPA update + import gates, client export-gate tests,
  rotation/staging/retention coverage, and the frontend module tests that
  previously did not exist; CI now runs the Node suite.

## Pass 1 carry-forward (still valid)

| ID | Finding | Sev | Status |
|----|---------|-----|--------|
| A1 | Default credentials on demo/POC | H shared host | ⏸️ POC default; H1 boot guard for `ENV=prod` |
| A2 | PII encryption incomplete | H COPPA | = **D16** ✅ decision + under-13 gate; residual plaintext documented |
| A3 | No PII access audit | H | Export = D1 ✅; player-360 view = **D19** ✅ |
| A4 | CSV export of minors’ PII ungated | M | ✅ H4.2 — `can_export_pii` + confirm; redaction helper |
| A5 | Key rotation not wired | M | = **D2** ✅ |
| B1 | `Secure` cookie | M | ✅ 2026-07-20 |
| B2 | Login rate limit process-local | M | = **D14** |
| B4 | Partial `html`` adoption | L | Ongoing where raw markup remains; preferred path is `html`/`hstr` |
| B5 | Unpinned deps | M | = **D12** ✅ |
| C1 | Huge `app.js` | H velocity | = **D11** ✅ |
| C2 | Large routers (`assignments`, `emails`, `importer`) | M | ✅ **emails + assignments** 2026-07-21 — emails: bulk/detect/stamp modules; assignments: `assignment_ops.py` + `assignments_bulk.py`; `importer` already separate |
| C4 | Docs slightly stale | L | = **D15** ✅ 2026-07-21 |

## Deep dive — 2026-07-20 (COPPA / export / crypto / ingest)

Scope: security & privacy path for real junior data; export accountability;
key rotation operability; SPA XSS primitives.

### Findings

| Topic | Result |
|-------|--------|
| **Encrypted at rest** | `email_message.body`, `player.emails` / `phones` / `birthdate` via Fernet; encrypt on write, decrypt on API read |
| **Not encrypted** | Player names, USTA #, city/state; official addresses; email subject/from (search). Documented tradeoff; **D16** |
| **Key rotation** | Was design-only → now MultiFernet + `reencrypt_pii.py` (**D2**) |
| **Export audit** | Server: payroll CSV + assignment CSV call `log_export`. Client: all `_csvDownload` paths fire `POST /api/export-audit`. |
| **View audit** | Player 360 (`GET /api/players/{id}/overview`) appends `access_audit` (**D19**). List: `GET /api/access-audit`. Catalog list / single GET not logged (noise). |
| **Ingest** | Header/Bearer preferred; `?token=` still for dev providers; **prod rejects query token** by default (**D4**) |
| **Sessions** | HttpOnly + SameSite=Strict; Secure auto in prod; TTL default 7d prod / 30d dev; force password change on default admin (**B1**, **D3**) |
| **XSS** | `html`/`hstr`/`esc` preferred path; residual raw `innerHTML` mostly AG Grid / print scaffolds; quote escape closed |
| **SQL** | Parameterized; f-strings only for fixed table/column fragments |

### Release gates (before real under-13 / shared host)

1. `ENV=prod` + non-default DB role/password + TLS + real `PII_ENCRYPTION_KEY(S)` (H1 already refuses boot otherwise)
2. ~~Change default admin password~~ ✅ D3 force-change in prod (`must_change_password` / `ADMIN_PASSWORD`)
3. `COURTOPS_SECURE_COOKIE` not required if ENV=prod (auto); session default **7** days in prod
4. Prefer header-only ingest; do not set `INGEST_ALLOW_QUERY_TOKEN` unless a provider forces it
5. Disk encryption + secret manager for keys (runbook in `pii-h2-key-management.md`)
6. ~~Explicit decision on **D16**~~ ✅ — `docs/coppa-policy.md` + `ALLOW_UNDER13_PII` + `GET /api/coppa/policy`

### Suggested sequencing (updated)

1. ~~MultiFernet rotation (D2)~~ ✅  
2. ~~Prod ingest query ban (D4) / Secure cookie default (B1) / dep pins (D12)~~ ✅  
3. ~~Thin COPPA policy for real junior data (**D16**)~~ ✅ — written policy + under-13 gate  
4. ~~Continue `app.js` slices (**D11**)~~ ✅ — composition root + factories  
5. ~~H4.2 / D19 / D10 / D17 / D3 / D8 / D15~~ ✅  
6. Mail provider wiring when public HTTPS + domain exist  
7. Optional later: log catalog single-GET / history  
8. **D18** CSRF tokens only if SPA leaves same-origin or cookie SameSite is relaxed

## How to update

- New finding → add row under **Open** with next free `D#` (or `E#` for UX).  
- Fix shipped → move to **Resolved** with date + one-line note.  
- Do not re-open archived `audit.md` (D1–D8 product decisions).  
