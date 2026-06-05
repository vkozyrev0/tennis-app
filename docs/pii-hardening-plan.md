# CourtOps Tennis — PII Hardening Plan (minors' data / COPPA)

> **Status:** plan only — no code changes in this document. It operationalizes
> the roadmap's parked *"PII-at-rest encryption + DB hardening"* item
> ([roadmap.md](roadmap.md) §On hold) and the audit's §5.1/§5.3 constraints,
> grounded in COPPA obligations confirmed by external research.
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
| `app_user`, `session` | login, `pbkdf2` hash, session token + expiry | Admin/officials | Auth (migration 0008/0017). Hash + expiry already in place. |

**Action A0 — confirm the population.** COPPA's strict obligations attach to
**under-13** data. Determine the actual age distribution (USTA junior divisions
run 10U–18U, so under-13 data *is* collected). If any under-13 → full COPPA
applies. Document this finding; it sets the compliance baseline.

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

## 3. Current gaps (CourtOps as built)

1. **DB auth:** default `postgres` superuser, password `postgres` in
   `config.py` defaults; DSN has **no `sslmode`** → no TLS. (`backend/app/config.py`)
2. **Encryption at rest:** none (no disk/volume encryption assumed; no
   column-level encryption for `emails`/`phones`/`birthdate`/email `body`).
3. **Retention/deletion:** no policy, no purge job; deletes (where they exist)
   don't guarantee `player_history` / `email_message` cleanup.
4. **Access logging / audit:** money calc has snapshots (audit §5.3), but there
   is **no audit trail for PII access** (who viewed/exported minors' data).
5. **Third-party assurances:** email auto-ingest + Maps geocoding are deferred;
   when added they become **processors** needing §312.8 written assurances.
6. **Data minimization:** CSV export of every list (incl. minors' PII) is
   ungated — any admin can bulk-export. No field-level redaction.

**Already in place (don't re-do):** admin/official **RBAC**, HttpOnly +
`SameSite=Strict` + `Secure` cookies, **session expiry + rotation** (0017),
pbkdf2 hashing, per-route cross-account guards. These are the parts of §312.8
that don't need new infrastructure.

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
  at rest" or LUKS/cloud KMS) — the baseline §312.8 measure.
- **H2.2 Column-level encryption** for the highest-risk free-text/contact
  fields: `email_message.body`/`subject`/`from_address`, `player.emails`,
  `player.phones`, and consider `player.birthdate`. Options: app-layer
  envelope encryption (KMS data key) or `pgcrypto`. Trade-off: encrypted
  columns can't be searched/regex-matched server-side — the **player detector
  and the new local extractors read `subject`/`body`**, so either (a) keep
  triage/detection in the app process after decrypt, or (b) encrypt only
  at-rest and decrypt into memory per request. Pick (a); document the boundary.
- **H2.3 Key management:** keys in a secret manager/KMS, rotation policy, never
  in the repo or DB.

**Done when:** disk + the listed columns are encrypted; detection/extraction
still works against decrypted-in-memory values; keys live outside the DB.

### Phase H3 — Retention & deletion *(§312.10)*
- **H3.1 Retention schedule.** ⏳ *Partial.* A redact endpoint exists
  (`POST /api/emails/purge?older_than_days=N`); the per-table **written
  schedule** (and a tournament-level sweep after the event) still needs to be
  defined + documented (the amended Rule likely **mandates a written policy** —
  confirm).
- **H3.2 Cascade-correct deletion.** ✅ **Done for players.** `DELETE
  /api/players/{id}` now erases PII from the FK-less `player_history` audit
  table (rows kept, PII columns nulled — the delete trigger's final snapshot is
  redacted too); roster + Part B rows already cascade, email links SET NULL.
  *(Verify other entities — e.g. officials' PII — similarly.)*
- **H3.3 Automated purge job** (scheduled) — ⏳ *Pending.* The
  `/api/emails/purge` endpoint is the building block (redacts filed-email
  body/subject/from_address older than N days, keeps provenance); wire it to a
  scheduler with a dry-run + a count-only log.

**Done when:** an aged-out tournament's minors' PII is provably gone (row +
history + email bodies), on a schedule, with a written policy.
**Status:** ✅ the erasure *mechanics* (player-history redaction on delete;
email-body redaction endpoint) ship + are tested; the *schedule/policy/job*
(H3.1 doc + H3.3 automation) remain.

### Phase H4 — Access control & audit
- **H4.1 PII-access audit log.** Append-only record of *who exported/viewed*
  minors' data (admin id, action, table, row-scope, timestamp) — store the
  *event*, not the PII. Surfaces accountability the money-snapshot pattern
  already models.
- **H4.2 Gate bulk export.** Make CSV export of minors'-PII lists a
  permissioned action (and audited via H4.1); consider field redaction for
  non-essential exports.
- **H4.3 Multi-user least privilege** (ties to D8): if more than the single TD
  gets access, scope roles so not everyone can read all minors' PII.

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
1. **Age distribution** — is under-13 data actually stored? (Sets COPPA baseline; §A0.)
2. **Final 2025 COPPA Rule text** — which of {written security program, written
   retention policy, separate consent for third-party/AI disclosure} are binding
   by **2026-04-22**? (Research couldn't confirm; read the Federal Register.)
3. **State youth-privacy laws** for the deployment jurisdiction (not researched).
4. **Deployment target** — managed Postgres (encryption-at-rest + TLS often
   turnkey) vs self-hosted (must configure LUKS/KMS + certs). Drives H1/H2 effort.
5. **Search vs encryption trade-off** — confirm the triage/detector can run on
   decrypted-in-memory `subject`/`body` so H2.2 doesn't break Part B (§4 H2.2).

---

## 7. Cross-references
- [roadmap.md](roadmap.md) — §On hold "PII encryption at rest / DB hardening".
- [audit.md](audit.md) — §5.1 (minors' PII / non-public), §5.3 (auditability).
- `backend/app/config.py` — DB DSN + default creds (H1).
- FTC COPPA FAQ + 16 CFR Part 312 — primary obligations (§2).
