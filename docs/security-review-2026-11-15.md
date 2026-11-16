# Security review — 2026-11-15 (Shannon pentest)

Autonomous pentest of the local Docker stack (`http://localhost:8000`, demo seed,
`admin/admin`) with [Shannon](https://github.com/KeygraphHQ/shannon) 3.5.1 on
`deepseek:deepseek-flash`, agentic SAST on, rules of engagement throttled. The
target was a disposable local copy; no hosted instance was touched.

- Run: 78 m 39 s, 62 proven exploits collapsed into **26 final findings** —
  1 critical, 5 high, 13 medium, 7 low. Every finding below was proven live
  ("no exploit, no report"); analysis-only hypotheses were discarded.
- Artifacts (outside the repo): `~/.shannon/workspaces/courtops-pentest1/`
  (`Security-Assessment-Report.{md,pdf}`, `report.sarif`, `report.json`).
- Tool setup, the one required local patch, and the upgrade runbook:
  [shannon.md](shannon.md).
- Agentic SAST failed during architecture mapping, so the report is the
  recon + exploitation stream only — that is a scan gap, not a clean bill.
- Every finding needs human review. A green re-scan proves those specific
  exploits no longer work; it is not a statement that the app is secure.

## Findings and disposition

Status: **fixed** (code changed, in the suite), **accepted** (intentional
behaviour, documented + mitigated where possible), **open**.

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| AUTH-01 | critical | Seeded `admin/admin` accepted and advertised on the login page | **fixed** — hint removed; demo credentials refused on any non-loopback host (`security.shared_deployment`) |
| AUTH-02 | high | Shared seeded password on all official accounts | **fixed** — same gate for `official`-role logins |
| AUTH-03 | high | Forced password rotation gated on `ENV=prod` (dev deploy bypassed it) | **fixed** — enforced on prod or any non-local host |
| AUTH-04 | high | Session cookie without `Secure`, no HSTS over plain HTTP | **fixed** — `Secure` on HTTPS/shared deployments; HSTS on TLS requests incl. `X-Forwarded-Proto` |
| AUTH-05 | high | Admin can reset a peer admin's password with no re-authentication | **fixed** — caller's `current_password` required; audited |
| AUTH-06 | medium | No password-length policy | **fixed** — 8-char floor on shared deployments (`check_password_policy`) |
| AUTH-07 | medium | No `Cache-Control: no-store` on authenticated PII responses | **fixed** — middleware sets `no-store` on every `/api` response |
| AUTH-08 | medium | 30-day sliding session with no absolute cap | **fixed** — `COURTOPS_SESSION_MAX_DAYS` (default 7) hard ceiling |
| AUTH-09 | medium | Official credential overwrite without proof of the current password | **fixed** — reset needs caller re-auth; one login per official; audited |
| AUTH-10 | medium | No throttle on current-password checks in change-password | **fixed** — 5 failures / 5 min per account |
| AUTH-11 | low | Unauthenticated logout clears the cookie (forced-logout CSRF) | **fixed** — same-origin required |
| AUTHZ-01 | high | `can_export_pii` not enforced on PII reads | **fixed** — revoked admins get PII-blind reads (`redact_fields` on players + inbox) |
| AUTHZ-02 | medium | Account holder can re-grant `can_export_pii` to itself | **fixed** — self-grant refused; change audited |
| AUTHZ-03 | medium | Export gate keyed on the client-supplied resource label | **fixed** — fail-closed: only a known operational allowlist skips the capability |
| AUTHZ-04 | medium | `deleted_at` ignored by tournament-scoped reads | **fixed** — roster + report routes 404 on a trashed tournament |
| AUTHZ-05 | medium | Bulk file action dispatched on a client-chosen classification | **fixed** — `classification` validated against the server registry |
| AUTHZ-06 | medium | No state machine on accept/decline; a paid assignment can be declined | **fixed** — refused once the assignment is settled in payroll (the demonstrated room-list/coverage harm) |
| AUTHZ-07 | medium | Settled payroll records/batches can be un-paid and deleted | **fixed** — batch members can only be walked back with the batch |
| AUTHZ-08 | medium | Roster update bypasses promotion + COPPA gates | **fixed** — `player_id` immutable; a withdrawn entry cannot be reinstated by edit |
| AUTHZ-09 | medium | Destructive retention/erasure wrote no audit row | **fixed** — purge, clear-inbox, player delete and capability changes are audited |
| AUTHZ-10 | low | TD-chat executor trusts the caller's `confirm` flag | **fixed** — server-minted single-use plan token required |
| AUTHZ-11 | low | `deleted_at` not enforced on inbox write paths | **fixed** — cleared rows 404 on write |
| AUTHZ-12 | low | Official portal widens tournament scope to every future event | **accepted** — self-declaring availability for upcoming events is the workflow; writes are now audited (who, dates, hotel flag) |
| AUTHZ-13 | low | Import merge trusts a trashed tournament and can be destroyed after merge | **fixed** — merge requires a live tournament |
| AUTHZ-14 | low | Mail-fetch jobs readable/cancellable by any admin with the token | **fixed** — job bound to its creator |
| AUTHZ-15 | low | Last-exporter guard is a non-atomic read-check-write | **fixed** — admin rows locked `FOR UPDATE`; delete path consults the guard |

## Second pass (same day, after the fixes)

The verification run (`courtops-pentest2`) did **not** reproduce any of the 26
findings above. It did find 18 new issues in the changed code, all exploited:

| New ID | Sev | Finding | Fix |
| --- | --- | --- | --- |
| — | critical | Client-controlled `Host` header disabled the demo-credential refusal and rotation | Gate is now **server config** (`COURTOPS_ALLOW_DEMO_CREDENTIALS`, default deny); no request header is consulted |
| — | high | Self password reset skips current-password proof | Required for every reset, self included |
| — | high | `PUT /api/emails/{id}` returned decrypted bodies to a blinded admin | Response honours the PII blind |
| — | high | Import-batch rows returned birthdates/parent contacts to a blinded admin | Staged rows redacted |
| — | medium | Password floor skipped for local-looking hosts | Floor is unconditional unless the demo opt-in is set |
| — | medium | Password change kept the caller's session (stolen token survived) | All sessions rotated; caller gets a fresh cookie |
| — | medium | Peer reset had no attempt limit | Shared re-auth throttle |
| — | medium | Aging/suggest/detect endpoints skipped the PII blind | Aging redacts sender; batch/detect paths covered with the list |
| — | medium | Payroll finalized a declined assignment | Refused (409) |
| — | medium | Player history returned birthdates to a blinded admin | Redacted |
| — | low | Batched payroll could be re-stamped (date/method) | Refused; the batch receipt wins |
| — | low | Bulk email handlers ignored `deleted_at` | Predicate added to bulk reads/writes |
| — | low | Soft-deleted tournaments writable by id | Roster create, imports upload, payroll finalize refuse a trashed event |
| — | low | Merged import batch could be deleted | Refused (409) + audited discard |
| — | low | Export capability is a client-side convention | Capability now blinds reads; a user who can *see* data can still copy it (documented limitation) |
| — | low | Availability rewrites for played tournaments | Refused once `play_end_date` passes |
| — | low | Cross-tournament correction rewrote another event's row | Same-tournament required |
| — | low | Responses accepted for already-played tournaments | Refused once the event has ended |

## Third pass (same day, after pass-2 fixes)

`courtops-pentest3` ran against a deployment with **no default credential**
(admin password rotated, demo opt-in off, seeded `official` logins refused —
verified live, including with a spoofed `Host`). Result: **26 findings, 0
critical, 3 high, 15 medium, 8 low**, and the credential/bypass class did not
reproduce at all.

Fixed from that pass:

| Area | Change |
| --- | --- |
| Session cookie | Secure by default; plain-HTTP dev opts out via `COURTOPS_SECURE_COOKIE=0` (compose does) |
| Login | Failed logins, the demo-credential refusal and logouts write `access_audit` rows; refusals answer a plain 401 so the response no longer reveals which accounts carry a shipped password |
| Login throttle | The attempt is counted *before* the password is checked, so a concurrent burst cannot evaluate more than the limit |
| Job ownership | The ownership check read `created_by`, which `snapshot()` never emitted — added to the wire shape, so the check actually applies |
| TD chat | A plan with no `tournament_id` is refused instead of skipping the scope check |
| Payroll | `finalize-all` skips declined assignments; a trashed tournament is refused on both finalize routes |
| Imports | A *partially* merged batch is no longer deletable (previously only `status='merged'` was guarded) |
| Email amends | The response honours the PII blind (it returned the decrypted row) |
| PII export grants | Only an exporter may create an exporter or grant the capability; a blinded admin cannot mint its way out of blinding |
| Corrections | A blinded admin cannot apply a correction from a mailbox it cannot read (the extractors saw null fields and blanked the live row) |

## Accepted, not fixed

These are real but they are product/policy decisions, not bugs, and patching
them would change how the tool is meant to be used:

- **No MFA and no idle timeout / step-up re-auth** (`AUTH-08`, `AUTH-09`). A TD
  desk on a trusted device is the intended deployment.
- **Admin-on-admin powers**: a peer can reset another admin's password (with its
  own password), delete a peer account, grant `can_export_pii` to a peer, and run
  a database-wide purge or retention sweep. Within one trust domain (a small TD
  team) this is intentional; it needs a role model, not a guard.
- **The inbox PII blind leaves names and USTA numbers visible** (`AUTHZ-06`).
  That is the operational core of the screen; body, sender, phone and birthdate
  are the redacted fields.
- **Export attestation trusts a client-chosen resource label** (`AUTHZ-10`).
  Unknown labels already fail closed; the rest is an attestation, not
  enforcement.
- **Roster / player-overview dietary and lodging notes** (`AUTHZ-15`),
  **withdrawal and late-entry free text** (`AUTHZ-16`), and **single-finalize
  allowing `pending`** (`AUTHZ-17`) remain as reported; each is a small
  follow-up rather than a design problem.

## Residual risk / not claimed

- **Demo data is not a security boundary.** The local seed keeps `admin/admin`
  and `official` for convenience on loopback; any non-loopback deployment
  refuses them (set a real `ADMIN_PASSWORD` and rotate official logins).
- **`can_export_pii` still cannot stop a curious admin from reading what the UI
  shows.** It now blinds the API reads for a revoked admin, but any user who can
  see a value can retype it. The control is a data-minimisation and
  accountability gate, not DRM.
- **In-process state** (login throttle, change-password throttle, fetch jobs,
  chat plans) is per worker. A multi-worker deployment needs a shared store;
  this is unchanged from before the review and is called out in each module.
- **Agentic SAST did not run** in this scan. A SAST pass (or a re-run with it
  enabled) is still worth doing.
- **No penetration test of the hosted Fly demo.** The rules here were written
  for a local stack.

## Verifying after a change

```bash
docker start courtops-test-pg          # Postgres 16 for the suite, host port 5544
cd backend && python -m pytest -q      # full suite (PGPORT=5544 from backend/.env)
python -m ruff check .                 # repo root
npx eslint .                           # repo root
```

Re-running Shannon after these changes should fail to reproduce the 25 fixed
findings above; AUTHZ-12 is expected to reproduce until the availability model
changes.
