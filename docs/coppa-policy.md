# CourtOps — Thin COPPA policy (minors / under-13)

> **Status:** written + partially enforced (2026-07-20). Closes audit **D16**
> “explicit decision” on residual plaintext vs more column crypto. This is a
> **POC / TD-back-office** posture, not legal advice. Confirm FTC final rule
> text and state youth-privacy laws for your jurisdiction before production
> use with real under-13 data.

Cross-refs: [pii-hardening-plan.md](pii-hardening-plan.md) ·
[pii-h2-key-management.md](pii-h2-key-management.md) ·
[audit-register.md](audit-register.md) (D16) · machine-readable
`GET /api/coppa/policy`.

---

## 1. Decision (D16)

**We accept residual plaintext** for fields that must stay SQL-searchable:

| Plaintext (by design) | Why |
|----------------------|-----|
| `player` name, USTA #, city/state/district/section | Catalog ILIKE search, roster match, division UX |
| `email_message.subject`, `from_address` | Inbox search + detector matching |

**We encrypt at rest (app-layer Fernet)** the highest-risk columns:

| Encrypted | Why |
|-----------|-----|
| `email_message.body` | Free-text minors/parents PII, health-adjacent notes |
| `player.emails`, `phones`, `birthdate` | Contact + exact age |

**Disk / volume encryption (H2.1)** on the database host remains **required**
for any shared or hosted deployment — column crypto is layered, not a substitute.

This is the explicit tradeoff the audit asked for: more column crypto on names
would break current search without blind indexes; we document and gate instead.

---

## 2. Under-13 gate

COPPA (16 CFR Part 312) attaches when an operator has **actual knowledge** of
under-13 personal information. USTA junior divisions include 10U–12U, so
under-13 data **is** in scope when those players are stored.

**Enforcement:** any API or import write that sets a `birthdate` implying age
**strictly under 13** is refused with **HTTP 403** unless allowed by env:

| `ALLOW_UNDER13_PII` | Effect |
|---------------------|--------|
| unset, `ENV=dev` (etc.) | **Allowed** — local POC, seed, tests |
| unset, `ENV=prod` | **Blocked** — cannot silently accumulate under-13 DOBs |
| `1` / `true` | **Allowed** — operator opts in under this policy |
| `0` / `false` | **Blocked** even in dev |

Year-only birthdates (`birthdate_precision=year`, stored `YYYY-01-01`) are aged
conservatively (treated as Dec 31 of that year) so we do not under-count age.

**Missing birthdate** is not auto-blocked (age unknown to the app). Operators
must not omit DOB to evade the gate when they know the player is under 13.

**Opt-in meaning:** setting `ALLOW_UNDER13_PII=1` records that the operator
accepts residual plaintext names/USTA # for under-13 players under the
controls below — it is not a full COPPA compliance certificate.

---

## 3. Controls already in the product

- **Access:** admin session for player catalog, inbox, exports; Secure cookie
  auto-on in prod; session TTL via `COURTOPS_SESSION_DAYS` (default **7** days
  in prod, 30 in dev). POC `admin/admin` sets `must_change_password`; prod API
  refuses work until rotated (`ADMIN_PASSWORD` / change-password).
- **Export accountability (H4.1):** browser + server CSVs → `export_audit`
  (who / resource / when — never row PII).
- **Export permission (H4.2):** full minors-PII CSV requires
  `user_account.can_export_pii` plus a SPA confirm (`detail.confirmed`). New
  secondary admins default **false**. Redacted column-stripped exports set
  `detail.redacted` (still need the capability flag).
- **View accountability (D19):** opening player 360 logs `access_audit`
  (`view_player_360` + player id + optional tournament — never names/contact).
  Review via `GET /api/access-audit`.
- **Retention (H3):** filed-email free text redacted after
  `EMAIL_RETENTION_DAYS` past tournament end (`POST /api/retention/sweep`).
- **Erasure (H3.2):** `DELETE /api/players/{id}` nulls PII on `player_history`.
- **Keys (H2.3):** `PII_ENCRYPTION_KEYS` MultiFernet + `reencrypt_pii.py`.
- **Boot guard (H1):** prod refuses default DB creds, non-TLS DSN, dev Fernet key.
- **Security headers (D17):** CSP (`script-src 'self'`, styles allow inline),
  `X-Frame-Options: DENY`, `nosniff`, referrer + permissions policy; HSTS when
  `ENV=prod` (or `COURTOPS_HSTS=1`).

Still open (not this thin policy): least-privilege multi-user (H4.3); optional
broader view logging (catalog GET / history); deploy-time disk encryption + KMS
key hosting; explicit CSRF token only if the SPA ever goes cross-site (D18 —
today SameSite=Strict + same-origin).

---

## 4. Release checklist (real under-13 or shared host)

1. `ENV=prod` + dedicated DB role/password + `PGSSLMODE=require` (or stricter)
2. Real `PII_ENCRYPTION_KEY` or `PII_ENCRYPTION_KEYS` (not the baked-in dev key)
3. Disk encryption on the DB volume; keys in a secret manager
4. Change default `admin` password
5. Schedule retention sweep; set `EMAIL_RETENTION_DAYS` deliberately
6. Only then set **`ALLOW_UNDER13_PII=1`** if under-13 juniors will be stored
7. Prefer header-only email ingest (`INGEST_ALLOW_QUERY_TOKEN` off)

---

## 5. Population note (plan A0)

USTA junior age groups **10U–18U** imply under-13 players are expected in real
junior events. The gate defaults **off in prod** so a shared deploy does not
quietly store that population until the operator opts in. Demo/seed data may
include under-13 birth years for local UX only (`ENV=dev`).
