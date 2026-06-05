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

Key: `PII_ENCRYPTION_KEY` (a urlsafe-base64 32-byte Fernet key). A fixed dev key
is used in non-prod; `require_key_or_raise()` (called from the H1 boot guard)
refuses to start a prod deployment without a real key.
"""
import os

from cryptography.fernet import Fernet, InvalidToken

# POC-only default so the local loop + tests work without configuration. NEVER
# acceptable for a shared deployment — the boot guard enforces a real key in prod.
_DEV_KEY = "xkJgdgxa83BRIz5CoNgVoNlM9rxBvBeYvONLFtmynSw="  # a valid throwaway Fernet key


def _key() -> bytes:
    return os.getenv("PII_ENCRYPTION_KEY", _DEV_KEY).encode()


def _fernet() -> Fernet:
    return Fernet(_key())


def using_dev_key() -> bool:
    return os.getenv("PII_ENCRYPTION_KEY", _DEV_KEY) == _DEV_KEY


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
