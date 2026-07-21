# CourtOps — Living Audit Register

Open findings from code/security/UX audits **after** the original TD-vision
audit (`audit.md`, archived 2026-05-27). Use this for work still in flight.

**Status:** ⬜ open · 🔄 in progress · ✅ resolved · ⏸️ deferred (explicit)

Severity: **H** high · **M** medium · **L** low

> **Product posture (2026-07-21):** still a POC; inbox triage/filing is the
> main day-to-day pain; email stays **manual paste** until mail infra exists.
> Hardening pass closed MultiFernet, export/view audit, COPPA gate, CSP headers,
> session/password defaults, official tournament scoping, and dep pins.

---

## Open

| ID | Finding | Sev | Notes |
|----|---------|-----|-------|
| D11 | `frontend/app.js` monolith; mixed `innerHTML` | M | Ongoing — +`dayof.js` venue panel; availability/payroll/shell/…; ~6.2k LOC left |
| D13 | No DB connection pool | ⏸️ | Trigger: multi-worker / multi-user |
| D14 | Login throttle process-local | ⏸️ | Trigger: multi-instance |
| D18 | CSRF not explicit | ⏸️ | **Deferred:** cookie is `SameSite=Strict` + SPA is same-origin only; add CSRF tokens if cross-site clients or non-browser consumers appear |


## Resolved (this register)

| ID | Finding | Resolved |
|----|---------|----------|
| H4.2 / A4 | Bulk minors-PII CSV ungated | ✅ 2026-07-20 — `can_export_pii` + confirm; `export_gate.py`; SPA gate |
| D19 | Full PII *view* audit (not just export) | ✅ 2026-07-21 — `access_audit` + log on player 360; `GET /api/access-audit` |
| D10 | `finalize_all` / invite-texts N×`_summary` | ✅ 2026-07-21 — both use `_summaries` (5 set queries) |
| D17 | No CSP / security headers on app | ✅ 2026-07-21 — middleware CSP + nosniff/frame/referrer/COOP; HSTS in prod |
| D3 | 30-day sessions + default `admin/admin` | ✅ 2026-07-21 — prod session default 7d; `must_change_password` + prod API gate; SPA force modal |
| D8 | Officials can list all tournaments | ✅ 2026-07-21 — `/me/tournaments` + availability scoped to assignment / prior avail / open events |
| D15 | Docs drift (suite counts, PII plan §3, design tree) | ✅ 2026-07-21 — ~591 tests / 89 files; migrations through 0055; plan/status sync |
| D16 | Residual plaintext / under-13 without policy | ✅ 2026-07-20 — `docs/coppa-policy.md`; `ALLOW_UNDER13_PII` gate; `GET /api/coppa/policy` |
| D2 | Fernet key rotation not operational | ✅ 2026-07-20 — MultiFernet + `PII_ENCRYPTION_KEYS` + `reencrypt_pii.py` |
| D4 | Ingest allows `?token=` | ✅ 2026-07-20 — refused when `ENV` is prod unless `INGEST_ALLOW_QUERY_TOKEN=1` |
| D12 | Unpinned `requirements.txt` | ✅ 2026-07-20 — version bounds + `requirements.lock` |
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
| B4 | Partial `html`` adoption | L | Ongoing with D11 |
| B5 | Unpinned deps | M | = **D12** ✅ |
| C1 | Huge `app.js` | H velocity | = **D11** |
| C2 | Large routers (`assignments`, `emails`, `importer`) | M | Optional splits |
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
| **XSS** | `html`/`hstr`/`esc` good path; residual raw `innerHTML` in monolith (**D11**); quote escape closed |
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
4. Continue `app.js` slices (**D11**)  
5. ~~H4.2 / D19 / D10 / D17 / D3 / D8 / D15~~ ✅  
6. Mail provider wiring when public HTTPS + domain exist  
7. Optional later: log catalog single-GET / history  
8. **D18** CSRF tokens only if SPA leaves same-origin or cookie SameSite is relaxed

## How to update

- New finding → add row under **Open** with next free `D#` (or `E#` for UX).  
- Fix shipped → move to **Resolved** with date + one-line note.  
- Do not re-open archived `audit.md` (D1–D8 product decisions).  
