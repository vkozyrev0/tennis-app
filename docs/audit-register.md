# CourtOps — Living Audit Register

Open findings from code/security/UX audits **after** the original TD-vision
audit (`audit.md`, archived 2026-05-27). Use this for work still in flight.

**Status:** ⬜ open · 🔄 in progress · ✅ resolved · ⏸️ deferred (explicit)

Severity: **H** high · **M** medium · **L** low

> **Product posture (2026-07-19):** still a POC; inbox triage/filing is the
> main day-to-day pain; email stays **manual paste** until mail infra exists;
> site/hotel API guards closed this round.

---

## Open

| ID | Finding | Sev | Notes |
|----|---------|-----|-------|
| D1 | No PII access/export audit log | H | Money is auditable; who viewed/exported minors’ data is not |
| D2 | Fernet key rotation not operational | M–H | Design in `pii-h2-key-management.md`; `crypto.py` is single-key only |
| D3 | 30-day sessions + default `admin/admin` on POC | M | Fine laptop-only; tighten before shared host |
| D4 | Ingest allows `?token=` | M | Prefer header-only in prod runbooks (app side shipped) |
| D8 | Officials can list all tournaments | L–M | `GET /api/me/tournaments` — needed for availability UX |
| D10 | `finalize_all` / some invite paths still N×`_summary` | L–M | Batch with `_summaries` |
| D11 | `frontend/app.js` ~8.4k LOC; mixed `innerHTML` | M | Continue module slices + `html`` adoption |
| D12 | Unpinned `requirements.txt` | M | Lockfile when deploys matter |
| D13 | No DB connection pool | ⏸️ | Trigger: multi-worker / multi-user |
| D14 | Login throttle process-local | ⏸️ | Trigger: multi-instance |
| D15 | Docs drift (PII plan §3, phase labels, suite counts) | L | Sync when touching those docs |

## Resolved (this register)

| ID | Finding | Resolved |
|----|---------|----------|
| D5 | Assignment `site_id` not tournament-scoped (API) | ✅ 2026-07-19 — `_check_assignment_refs` on create/update/bulk |
| D6 | Assignment `room_block_id` not tournament-scoped (API) | ✅ 2026-07-19 — same helper |
| D9 | Inbox list re-ran extractors per row | ✅ 2026-07-19 — migration 0051 stamp + column reads; search/paging UX |
| — | Day-of L1 left previous panel on screen | ✅ 2026-07-19 — `activateGroup` always activates a tab |
| — | Email auto-ingest app side (D4) | ✅ 2026-07-19 — migration 0050 + webhook; provider wiring still external |

## Pass 1 carry-forward (still valid)

| ID | Finding | Sev | Status |
|----|---------|-----|--------|
| A1 | Default credentials on demo/POC | H shared host | ⏸️ POC default; H1 boot guard for `ENV=prod` |
| A2 | PII encryption incomplete | H COPPA | Partial: body + player emails/phones/birthdate encrypted; names + official addresses plaintext |
| A3 | No PII access audit | H | = **D1** |
| A4 | CSV export of minors’ PII ungated | M | Admin-only; no redaction/export log |
| A5 | Key rotation not wired | M | = **D2** |
| B1 | `Secure` cookie only via `COURTOPS_SECURE_COOKIE` | M | Document at deploy |
| B2 | Login rate limit process-local | M | = **D14** |
| B4 | Partial `html`` adoption | L | Ongoing with D11 |
| B5 | Unpinned deps | M | = **D12** |
| C1 | Huge `app.js` | H velocity | = **D11** |
| C2 | Large routers (`assignments`, `emails`, `importer`) | M | Optional splits |
| C4 | Docs slightly stale | L | = **D15** |

## Suggested sequencing (POC)

1. ~~Commit ingest + Day-of~~ ✅  
2. ~~API site/hotel tournament guards (D5/D6)~~ ✅  
3. ~~Inbox performance (D9)~~ ✅  
4. Thin COPPA when real junior data is imminent (D1/D2/A2)  
5. Mail provider wiring when public HTTPS + domain exist  

## How to update

- New finding → add row under **Open** with next free `D#` (or `E#` for UX).  
- Fix shipped → move to **Resolved** with date + one-line note.  
- Do not re-open archived `audit.md` (D1–D8 product decisions).  
