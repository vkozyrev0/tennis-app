"""Application-layer encryption for PII at rest (PII hardening H2).

Encrypts the highest-risk free-text — currently the **inbound email body**, the
largest unstructured store of minors'/parents' PII — with Fernet (AES-128-CBC +
HMAC). The ciphertext is urlsafe-base64 text, so the column stays `text`; no
schema change or data migration is needed:

- `encrypt()` is applied on write (create_email);
- `decrypt()` is applied on read and **passes through** anything that isn't a
  valid token, so pre-existing plaintext rows keep working and become encrypted
  only as they're re-saved.

Detection / triage / extraction read the body **after** `decrypt()`, in app
memory — so encrypting at rest doesn't break the (regex-based, no-LLM) parsing.
Extending to subject / from_address / player contact fields is the same pattern.

Keys (H2.3 rotation — see docs/pii-h2-key-management.md):

- ``PII_ENCRYPTION_KEYS`` — comma-separated Fernet keys, **newest first**.
  Encrypts with the first key; decrypts by trying each (``MultiFernet``).
- ``PII_ENCRYPTION_KEY`` — single-key alias (legacy / simple deploys).

A fixed dev key is used in non-prod when neither is set; ``using_dev_key()``
(called from the H1 boot guard) refuses to start a prod deployment that still
includes the dev key.
"""
import os

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

# POC-only default so the local loop + tests work without configuration. NEVER
# acceptable for a shared deployment — the boot guard enforces a real key in prod.
_DEV_KEY = "xkJgdgxa83BRIz5CoNgVoNlM9rxBvBeYvONLFtmynSw="  # a valid throwaway Fernet key


def _keys() -> list[str]:
    """Fernet key material, newest first. Empty env → single dev key."""
    raw = os.getenv("PII_ENCRYPTION_KEYS") or os.getenv("PII_ENCRYPTION_KEY", _DEV_KEY)
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    return keys or [_DEV_KEY]


def _fernet() -> MultiFernet:
    return MultiFernet([Fernet(k.encode()) for k in _keys()])


def using_dev_key() -> bool:
    """True if the configured key set still includes the baked-in POC key."""
    return _DEV_KEY in _keys()


def primary_key_id() -> str:
    """Short fingerprint of the primary (encrypt) key for ops logs — not secret."""
    k = _keys()[0]
    return k[:8] + "…" + k[-4:] if len(k) > 16 else k[:8]


def encrypt(plaintext: str | None) -> str | None:
    """Encrypt a string to a Fernet token (text). None / '' pass through."""
    if not plaintext:
        return plaintext
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(value: str | None) -> str | None:
    """Decrypt a Fernet token back to plaintext. Anything that isn't a valid
    token (legacy plaintext, NULL) is returned unchanged."""
    if not value:
        return value
    try:
        return _fernet().decrypt(value.encode()).decode()
    except (InvalidToken, ValueError):
        return value


def rotate_token(value: str | None) -> str | None:
    """Re-wrap ciphertext under the primary key without materializing plaintext.

    Used by ``reencrypt_pii.py`` during key rotation. Non-tokens / NULL / empty
    pass through unchanged (legacy plaintext is left for normal write paths or
    an opt-in plaintext→encrypt pass).
    """
    if not value:
        return value
    try:
        return _fernet().rotate(value.encode()).decode()
    except (InvalidToken, ValueError):
        return value
