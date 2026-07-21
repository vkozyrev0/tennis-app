# CourtOps Tennis — PII Hardening Plan (minors' data / COPPA)

> **Status (2026-07-21):** H1 enforcement, H2.2 column encryption, **H2.3
> MultiFernet rotation + `reencrypt_pii.py`**, H3 retention/erasure mechanics,
> H4.1 export + view audit, H4.2 export gate, D16 under-13 policy — all ship
> (per-item marks below). Still deploy-time: H1.1 least-priv DB role, H1.4 app
> TLS, H2.1 disk encryption, secret-manager hosting for keys, H3.3 cron, H4.3
> multi-role least privilege. Plan of record for COPPA-oriented hardening;
> operational companion: [coppa-policy.md](coppa-policy.md).
>
> **Why now:** CourtOps stores minors' personal data (junior players: names,
> USTA #, birth year/date, city/state, parent emails/phones, free-text emails).
> A youth-sports admin tool that knowingly stores under-13 data is **within
> COPPA's scope** (16 CFR Part 312). The POC's defaults — localhost Postgres on
> `postgres`/`postgres`, no TLS, no encryption at rest, no retention/deletion —
> are acceptable for local dev **only** and must change before any shared or
> hosted deployment.

---

## 1. Data inventory — what PII lives where

| Store | Sensitive fields | Subjects | Notes |
|-------|------------------|----------|-------|
| `player` | `first_name`, `last_name`, `usta_number`, `birthdate` (+`birthdate_precision`), `gender`, `city`, `state`, `district`, `section`, `emails`, `phones` | **Minors** (juniors) + adults | The core minors'-PII table. `emails`/`phones` are often a **parent's** contact info. |
| `player_history` | name/birthdate snapshots (SCD-4, migration 0004) | Minors | Append-only history → **retention/deletion must cascade here too**, or it silently retains deleted data. |
| `email_message` | `from_address`, `subject`, **`body`** | Minors + parents | Free-text inbound email — the **highest-risk** store: unstructured minors' info, addresses, reasons (injuries/illness = health-adjacent). |
| `late_entry`, `withdrawal`, `scheduling_avoidance`, `division_flexibility`, `pairing_avoidance`, `doubles_request`, `player_hotel_stay`, `tournament_entry` | player linkage + free-text (`reason`, `notes`, `hotel_name`, t-shirt/dietary) | Minors | Part B lists; `dietary_preference` may reveal health/religious data. |
| `official` | name, home street/city/state/zip, `phone`, `email`, `dietary_restrictions` | Adults | Not COPPA, but still PII subject to §312.8-style care + state law. |
| `user_account`, `session` | login, `pbkdf2` hash, session token + expiry | Admin/officials | Auth (migration 0008/0017). Hash + expiry already in place. |

**Action A0 — confirm the population.** ✅ **Documented (2026-07-20).** COPPA's
strict obligations attach to **under-13** data. USTA junior divisions run
10U–18U, so under-13 data *is* expected for real junior events. See
[coppa-policy.md](coppa-policy.md) §5. Prod refuses under-13 **birthdate**
writes unless `ALLOW_UNDER13_PII=1`.

---

## 2. Obligations (confirmed)

From FTC primary guidance + 16 CFR Part 312 (research-verified, high confidence):

- **Scope (§312.2/.3):** knowingly storing under-13 personal info → covered,
  including a *general-audience* service with **actual knowledge** it collects
  under-13 PII.
- **Security (§312.8):** maintain **confidentiality, security, and integrity**
  of children's data; take **reasonable steps to release it only to parties
  capable of maintaining its confidentiality and security** (i.e. vet/obtain
  written assurances from downstream recipients — hosting, email ingestion,
  any processor).
- **Retention (§312.10):** retain children's PII **only as long as reasonably
  necessary** for the purpose collected, then **delete** using reasonable
  measures against unauthorized access.

**To confirm against the final Rule (do not rely on until verified):** the 2025
COPPA amendments (compliance deadline **April 22, 2026**) reportedly add a
**written information-security program** (designated coordinator, ~annual risk
assessments) and a **written data-retention policy**, plus possibly separate
parental consent for third-party/AI disclosures. These specific items did **not**
survive adversarial verification in the research pass — read the Federal Register
final text before treating them as binding.

**Also confirm:** applicable **US state youth-privacy laws** (e.g. CA/CO/CT/etc.)
for the deployment's jurisdiction — not researched here.

---

## 3. Gaps vs remaining work (CourtOps as built, 2026-07-21)

### Still open (deploy or product)

1. **Least-privilege DB role + disk encryption + app TLS** — H1.1 / H1.4 / H2.1
   (enforcement of non-default DB creds + `PGSSLMODE` already ships in H1.2/H1.3).
2. **Secret manager / KMS** for Fernet keys — app MultiFernet rotation ships;
   hosting keys outside the process env is still ops.
3. **Retention cron** — `POST /api/retention/sweep` ships; schedule is deploy-time.
4. **Third-party assurances** — email provider / Maps geocoding as processors
   when wired for real junior data.
5. **H4.3 multi-user least privilege** — beyond single-TD + `can_export_pii`.
6. **Catalog list / single-GET view logging** — optional noise tradeoff (D19
   covers player 360 only).

### Closed in app code (do not re-open as gaps)

| Area | Status |
|------|--------|
| Column encryption (body, emails, phones, birthdate) | ✅ H2.2 |
| MultiFernet + `reencrypt_pii.py` | ✅ H2.3 app path |
| Export audit + SPA CSV log | ✅ H4.1 / D1 |
| Player-360 view audit | ✅ D19 / `access_audit` |
| Minors-PII export gate | ✅ H4.2 |
| Under-13 write gate + policy doc | ✅ D16 |
| Secure cookie auto prod; session days; force password change | ✅ B1 / D3 |
| Security headers / CSP | ✅ D17 |
| Official tournament list scoped | ✅ D8 |

**Already in place (don't re-do):** admin/official **RBAC**, HttpOnly +
`SameSite=Strict` + `Secure` cookies, **session expiry + rotation** (0017),
pbkdf2 hashing, per-route cross-account guards.

---

## 4. Remediation plan (phased, prioritized)

### Phase H1 — Deployment baseline *(blocks any shared/hosted deploy; no app rewrite)*
- **H1.1 Least-privilege DB role.** ⏳ *Pending (deploy-time).* Create a
  dedicated app role (not superuser) with `SELECT/INSERT/UPDATE/DELETE` on app
  tables only; keep DDL/migrations under a separate migrator role. Deferred from
  the first PR because creating roles in a migration would also touch the
  dev/test DBs; do it as a deploy provisioning step.
- **H1.2 Secrets from environment + fail-fast guard.** ✅ **Done.**
  `Settings.validate()` (`app/config.py`) refuses to start when `ENV` is
  non-dev and `PGUSER`/`PGPASSWORD` are the `postgres` defaults; called at
  import in `app/main.py`. No-op in dev/test. (`ENV` added; `.env.example`
  documents it.)
- **H1.3 TLS to the database.** ✅ **Done.** `PGSSLMODE` added to both DSNs
  (default `prefer` for dev — TLS-if-available with fallback); `validate()`
  requires `require`/`verify-ca`/`verify-full` in prod.
- **H1.4 App-server TLS.** ⏳ *Pending (deploy-time).* Terminate HTTPS in front
  of uvicorn (reverse proxy); cookies are already `Secure`, which **requires**
  HTTPS to function.

**Done when:** the app runs against a non-default, least-privilege, TLS DB user
with secrets from env, and refuses to boot on POC defaults outside dev.
**Status:** ✅ the *enforcement* (H1.2/H1.3) ships; H1.1/H1.4 are deploy-time
provisioning steps.

### Phase H2 — Encryption at rest
- **H2.1 Volume/disk encryption** on the DB host (managed-Postgres "encryption
  at rest" or LUKS/cloud KMS) — the baseline §312.8 measure. ⏳ *Deploy-time.*
- **H2.2 Column-level encryption.** ✅ **Done — `email_message.body`,
  `player.emails`/`phones`, and `player.birthdate` ship.** `app/crypto.py`
  (Fernet) encrypts on write, decrypts on read; ciphertext is base64 text. The
  text columns needed no schema change (`decrypt()` passes through legacy
  plaintext); **`birthdate` was `date`** so migration 0037 changes it to `text`
  and — because Fernet is non-deterministic — drops it from the history trigger's
  equality-based change detection (still snapshotted on a name change; names
  remain the audit anchor). Chose **option (a)**: the body flows
  decrypted-in-memory to the detector/extractors so no-LLM parsing is unaffected.
  **Intentionally left plaintext:** `email_message.subject` / `from_address` —
  they back the server-side inbox search (SQL `ILIKE`) and the detector's
  subject/sender matching, so encrypting them would break both (documented
  trade-off; covered by disk-level H2.1 instead).
- **H2.3 Key management.** ✅ **App path done (2026-07-20).** `PII_ENCRYPTION_KEY`
  and plural `PII_ENCRYPTION_KEYS` (MultiFernet, newest first) in
  `app/crypto.py`; `reencrypt_pii.py` backfill; prod boot guard refuses the
  POC dev key. *Remaining deploy-time:* secret-manager/KMS hosting + backup
  retention (runbook still in [pii-h2-key-management.md](pii-h2-key-management.md)).

**Done when:** disk + the listed columns are encrypted; detection/extraction
still works against decrypted-in-memory values; keys live outside the DB.
**Status:** ✅ column crypto + MultiFernet + re-encrypt tool + prod key-guard;
disk encryption + KMS hosting remain deploy-time.

### Phase H3 — Retention & deletion *(§312.10)*
- **H3.1 Retention schedule.** ✅ **Done (email bodies).** The written schedule
  is machine-readable at `GET /api/retention/policy` (`app/retention.py`):
  filed-email free text is redacted once its tournament **concluded**
  (`play_end_date`) more than `EMAIL_RETENTION_DAYS` (default 90) ago. *(Extend
  the schedule to Part B free-text notes + a player-PII rule as those stores are
  covered.)*
- **H3.2 Cascade-correct deletion.** ✅ **Done for players.** `DELETE
  /api/players/{id}` now erases PII from the FK-less `player_history` audit
  table (rows kept, PII columns nulled — the delete trigger's final snapshot is
  redacted too); roster + Part B rows already cascade, email links SET NULL.
  *(Verify other entities — e.g. officials' PII — similarly.)*
- **H3.3 Automated purge job** — ✅ **Done (the job); scheduling is deploy-time.**
  `POST /api/retention/sweep` runs the policy with a **`dry_run`** mode (counts
  only; default) and **count-only** results — never logs the data. Wire it to a
  cron / systemd timer in production. `/api/emails/purge` remains as a manual
  received-at-based override.

**Done when:** an aged-out tournament's minors' PII is provably gone (row +
history + email bodies), on a schedule, with a written policy.
**Status:** ✅ the erasure *mechanics* (player-history redaction on delete;
email-body redaction endpoint) ship + are tested; the *schedule/policy/job*
(H3.1 doc + H3.3 automation) remain.

### Phase H4 — Access control & audit
- **H4.1 PII-access audit log.** ✅ **Done (export 2026-07-19 + view 2026-07-21).**
  Append-only `export_audit` (migration 0052): who / resource / tournament /
  time / client_kind / detail (row_count, filename — never row PII). Browser
  CSVs POST `/api/export-audit`; server CSVs insert directly. List via
  `GET /api/export-audit`. **View trail (D19):** `access_audit` (migration
  0054) on `GET /api/players/{id}/overview` (`view_player_360` + player id);
  list via `GET /api/access-audit`. No dedicated SPA surface yet (API is enough
  for POC accountability).
- **H4.2 Gate bulk export.** ✅ **Done (2026-07-20).** `user_account.can_export_pii`
  (migration 0053; new admins default **false**, seed admin **true**). Minors-PII
  browser exports POST `/api/export-audit` only with capability +
  `detail.confirmed` (SPA confirm) or `detail.redacted`. Resource classifier +
  redaction helpers in `app/export_gate.py`. Toggle via
  `PATCH /api/admin/users/{id}`.
- **H4.3 Multi-user least privilege:** if more than the single TD gets access,
  scope roles so not everyone can read all minors' PII. *(Related: officials'
  tournament list is now scoped — audit **D8** — but admin multi-role PII
  isolation is still open.)*

### Phase H5 — Processors & policy *(§312.8 downstream)*
- **H5.1 Written assurances** from any third party that touches the data:
  hosting/DB provider, the future email-ingestion service, Google Maps
  geocoding (note: geocoding an official's *home address* sends PII off-site —
  prefer geocoding **site** addresses only, or a privacy-preserving lookup).
- **H5.2 Information-security program doc** (coordinator, risk assessment
  cadence) — **confirm whether the amended Rule mandates this**, then write it.
- **H5.3 Privacy notice / parental-consent posture** — if the channel ever
  collects from children directly. Today players don't log in (email-only),
  which limits direct collection; document that as a deliberate control.

---

## 5. Concrete first PR (smallest safe step)
Phase **H1** is the highest value-to-risk: it's config-only, needs no schema
change, and removes the most dangerous default (superuser + no TLS).

- `backend/app/config.py`: add `ENV` (`dev`/`prod`), a boot-time guard that
  refuses default creds when `ENV != dev`, and `sslmode` on both DSNs.
- `backend/.env.example`: document the new required vars.
- `backend/README.md` + `docs/roadmap.md`: move the §Stack security note from
  "post-POC" warning to an enforced check; link this plan.
- A migration adding the least-privilege app role + grants (run by the migrator).

**Acceptance:** app boots in `dev` unchanged; in `prod` it **refuses to start**
on `postgres`/`postgres` or a non-TLS DSN; tests still pass against a dev DB.

---

## 6. Open questions (must answer before relying on the plan)
1. ~~**Age distribution**~~ ✅ USTA 10U–18U ⇒ under-13 in scope; gate + policy in
   [coppa-policy.md](coppa-policy.md) (A0 / D16).
2. **Final 2025 COPPA Rule text** — which of {written security program, written
   retention policy, separate consent for third-party/AI disclosure} are binding
   by **2026-04-22**? (Research couldn't confirm; read the Federal Register.)
3. **State youth-privacy laws** for the deployment jurisdiction (not researched).
4. **Deployment target** — managed Postgres (encryption-at-rest + TLS often
   turnkey) vs self-hosted (must configure LUKS/KMS + certs). Drives H1/H2 effort.
5. ~~**Search vs encryption trade-off**~~ ✅ H2.2: body/contact/DOB encrypted;
   subject/from + names stay plaintext for search (D16 decision).

---

## 7. Cross-references
- [coppa-policy.md](coppa-policy.md) — **D16** written decision + under-13 gate (`ALLOW_UNDER13_PII`).
- [roadmap.md](roadmap.md) — §On hold "PII encryption at rest / DB hardening".
- [audit.md](audit.md) — §5.1 (minors' PII / non-public), §5.3 (auditability).
- `backend/app/config.py` — DB DSN + default creds (H1).
- `backend/app/coppa.py` — under-13 age math + gate + `GET /api/coppa/policy`.
- [pii-h2-key-management.md](pii-h2-key-management.md) — H2.3 key-management & rotation design.
- FTC COPPA FAQ + 16 CFR Part 312 — primary obligations (§2).
