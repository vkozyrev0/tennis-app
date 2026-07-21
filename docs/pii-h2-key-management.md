# PII H2 — Key management & rotation design

> **Status:** MultiFernet + re-encrypt backfill **implemented** (2026-07-20) in
> `backend/app/crypto.py` and `backend/reencrypt_pii.py`. Secret-manager choice
> and backup-key retention remain deploy/runbook decisions. Companion to
> [pii-hardening-plan.md](pii-hardening-plan.md) §H2.

## 1. Current state (what already ships)

Application-layer encryption is implemented in `backend/app/crypto.py` (Fernet =
AES-128-CBC + HMAC-SHA256, ciphertext is urlsafe-base64 **text**, so columns
stay `text` and need no schema change):

- **Encrypted at rest today:** `email_message.body`, `player.emails`,
  `player.phones`, `player.birthdate` (migration 0037 widened `birthdate`
  `date`→`text`). Encrypt on write, `decrypt()` on read; detection/triage/search
  over the body run on the decrypted-in-memory value.
- **Deliberately NOT encrypted:** `email_message.subject` / `from_address` — they
  back the server-side inbox `ILIKE` search and the detector's subject/sender
  matching; encrypting them breaks both. Covered by the disk-level baseline
  (H2.1) instead.
- **`decrypt()` passes through** anything that isn't a valid token, so legacy
  plaintext rows keep working and become ciphertext as they're re-saved.
- **Key today:** a single `PII_ENCRYPTION_KEY` env var (urlsafe-base64 32-byte
  Fernet key). A POC dev default is baked for local/test; the H1 boot guard
  (`config.py validate()` → `crypto.using_dev_key()`) **refuses to start a prod
  deployment** still using the dev key.

What's missing for production: (a) the key should live in a real secret store, not
an env var pasted by hand; (b) ~~there is no rotation path~~ ✅ MultiFernet +
`reencrypt_pii.py` (2026-07-20) — ops still need a key-generation/backup runbook.

## 2. H2.1 — Disk/volume encryption (baseline, deploy-time)

The §312.8 baseline, independent of app-layer crypto and covering the
*unencrypted* columns (subject/from_address, indexes, WAL, temp files, backups):

- **Managed Postgres** (RDS / Cloud SQL / Fly Postgres): enable "encryption at
  rest" at provision time (KMS-backed). Usually one checkbox; verify it covers
  **automated backups + snapshots + WAL**, not just the primary volume.
- **Self-hosted:** LUKS (or cloud block-volume encryption) under the data
  directory; ensure backup destinations are encrypted too.
- This is a provisioning step, not code — capture it in the deploy runbook (§5).

## 3. H2.3 — Key storage

The key must never sit in the image, the repo, or a committed `.env`.

- **Source of record:** a secret manager — AWS Secrets Manager / GCP Secret
  Manager / Fly secrets / Vault. The app reads the key from the environment; the
  platform injects it from the secret store at boot (e.g. `fly secrets set`,
  ECS task secrets, k8s `Secret` → env). The app stays storage-agnostic.
- **Blast radius:** the key decrypts every encrypted PII column, so treat it as a
  top-tier secret — restricted IAM read, access-audited, never logged. (`crypto`
  must never log the key or plaintext; verify on review.)
- **At-rest for the key itself:** the secret manager encrypts it with a
  cloud KMS CMK; disk encryption (H2.1) is the second layer.

## 4. H2.3 — Rotation design (the core deliverable)

**Goal:** roll `PII_ENCRYPTION_KEY` periodically (and immediately on suspected
compromise) with **zero downtime** and **no data loss**, without a flag-day
re-encrypt of the whole DB before the new key works.

**Mechanism — `MultiFernet`.** `cryptography` provides `MultiFernet([f_new,
f_old, …])`: it **encrypts with the first** key and **decrypts by trying each**
in order. That gives a window where both keys are valid, so old ciphertext still
reads while new writes use the new key — the basis for online rotation.

**Shipped** in `app/crypto.py` (plural keys, newest first; back-compatible — a
single `PII_ENCRYPTION_KEY` behaves exactly as before):

```python
# PII_ENCRYPTION_KEYS: comma-separated Fernet keys, NEWEST FIRST.
# (PII_ENCRYPTION_KEY stays accepted as the single-key alias.)
def _keys() -> list[str]:
    raw = os.getenv("PII_ENCRYPTION_KEYS") or os.getenv("PII_ENCRYPTION_KEY", _DEV_KEY)
    return [k.strip() for k in raw.split(",") if k.strip()]

def _fernet() -> MultiFernet:
    return MultiFernet([Fernet(k.encode()) for k in _keys()])
# encrypt() → token under keys[0]; decrypt() → tries all, else pass-through.
# rotate_token() → MultiFernet.rotate (no plaintext in caller).
```

**Rotation sequence (zero-downtime):**

1. Generate a new Fernet key; add it to the secret store so the value is
   `NEWKEY,OLDKEY` (new first). Deploy/restart. Now: **new writes** use NEWKEY;
   **reads** still succeed for OLDKEY ciphertext. No data touched yet.
2. Run the **re-encrypt backfill** (below) — rewrites every encrypted column so
   its ciphertext is under NEWKEY. Idempotent and resumable; safe to run live
   (each row: `decrypt()` then `encrypt()`, both under MultiFernet).
3. Once the backfill reports 0 rows still decrypting under OLDKEY, drop OLDKEY
   from the secret (`PII_ENCRYPTION_KEYS=NEWKEY`) and redeploy. OLDKEY is now
   retired and can be destroyed per policy.

**Re-encrypt backfill — shipped as `backend/reencrypt_pii.py`.**

```bash
cd backend
python reencrypt_pii.py              # dry-run counts only
python reencrypt_pii.py --apply      # re-wrap under primary key
```

Walks encrypted columns in batches; uses `crypto.rotate_token()` /
`MultiFernet.rotate()` so plaintext never materializes in the script.

- Use `mf.rotate()` (not decrypt→encrypt) so plaintext never materializes in a
  variable. Skip legacy-plaintext / NULL (not a token) — they get encrypted
  lazily on next normal save, or by a separate opt-in pass.
- Batch + commit per N rows so it's resumable; log counts only, never values.
- `birthdate` is `text` and dropped from the history-trigger equality check
  (Fernet is non-deterministic), so re-encryption won't spuriously trip the
  change trigger — confirm that still holds when wiring the backfill.

## 5. Operational runbook

- **Initial prod deploy:** provision managed PG with encryption-at-rest (H2.1) +
  TLS; `Fernet.generate_key()` → store as `PII_ENCRYPTION_KEYS` in the secret
  manager; deploy. Boot guard refuses the dev key. Optionally run the backfill
  once to encrypt any imported legacy plaintext.
- **Scheduled rotation (e.g. annually):** §4 steps 1→3.
- **Compromise response:** rotate immediately (§4); shorten step 2 by running the
  backfill at higher concurrency; destroy the leaked key after step 3; review
  access logs on the secret.
- **Restore-from-backup:** a backup is only readable with a key from its era —
  retain retired keys in cold storage for the backup-retention window before
  destroying, or re-encrypt backups on rotation. Decide per backup policy.

## 6. Open questions

1. **Secret-manager choice** — follows the deployment target (managed vs
   self-hosted); drives the injection mechanism, not the app code.
2. **Backup-key retention** — how long retired keys live to keep old backups
   readable (§5) vs destroy-on-rotation for a cleaner blast radius.
3. **Subject/sender** — accept them as plaintext-under-disk-encryption
   (current decision) or move inbox search to a separate searchable index so the
   columns can be encrypted too (larger change; deferred).
4. **Per-record vs single key** — a single app key is assumed; envelope
   encryption (per-row data key wrapped by a KMS CMK) is heavier and unjustified
   at single-TD scale, noted only for completeness.

## 7. Cross-references
- [pii-hardening-plan.md](pii-hardening-plan.md) §H2 (column-level done; this
  designs H2.3 key management/rotation).
- `backend/app/crypto.py` — current Fernet single-key implementation.
- `backend/app/config.py` `validate()` — H1 boot guard (refuses the dev key).
- migration `0037` — `birthdate` `date`→`text` for encryption.
