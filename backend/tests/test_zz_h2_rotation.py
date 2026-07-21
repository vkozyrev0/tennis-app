"""PII H2.3: MultiFernet key lists + rotate_token (docs/pii-h2-key-management.md).

Pure unit tests — no DB required for crypto; one integration check when DB is up.
"""
import os

import pytest
from cryptography.fernet import Fernet

from app import crypto


@pytest.fixture
def two_keys(monkeypatch):
    old = Fernet.generate_key().decode()
    new = Fernet.generate_key().decode()
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{new},{old}")
    monkeypatch.delenv("PII_ENCRYPTION_KEY", raising=False)
    return new, old


def test_encrypt_uses_primary_decrypt_accepts_old(two_keys, monkeypatch):
    new, old = two_keys
    plain = "minor PII under rotation"
    # Ciphertext under OLD only
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", old)
    token_old = crypto.encrypt(plain)
    # Dual-key window: NEW first
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{new},{old}")
    assert crypto.decrypt(token_old) == plain
    token_new = crypto.encrypt(plain)
    assert crypto.decrypt(token_new) == plain
    # After retiring OLD, old ciphertext fails → passthrough (not valid under NEW)
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", new)
    assert crypto.decrypt(token_old) == token_old  # passthrough legacy/invalid
    assert crypto.decrypt(token_new) == plain


def test_rotate_token_rewrites_under_primary(two_keys, monkeypatch):
    new, old = two_keys
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", old)
    token_old = crypto.encrypt("rotate-me")
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{new},{old}")
    rotated = crypto.rotate_token(token_old)
    assert rotated != token_old
    assert crypto.decrypt(rotated) == "rotate-me"
    # Primary-only can still read the rotated token
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", new)
    assert crypto.decrypt(rotated) == "rotate-me"


def test_rotate_passthrough_plaintext_and_empty(two_keys):
    assert crypto.rotate_token("not a fernet token") == "not a fernet token"
    assert crypto.rotate_token(None) is None
    assert crypto.rotate_token("") == ""


def test_using_dev_key_detects_dev_in_list(monkeypatch):
    monkeypatch.delenv("PII_ENCRYPTION_KEYS", raising=False)
    monkeypatch.delenv("PII_ENCRYPTION_KEY", raising=False)
    assert crypto.using_dev_key() is True
    real = Fernet.generate_key().decode()
    monkeypatch.setenv("PII_ENCRYPTION_KEY", real)
    assert crypto.using_dev_key() is False
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{real},{crypto._DEV_KEY}")
    assert crypto.using_dev_key() is True


def test_single_key_alias_still_works(monkeypatch):
    k = Fernet.generate_key().decode()
    monkeypatch.delenv("PII_ENCRYPTION_KEYS", raising=False)
    monkeypatch.setenv("PII_ENCRYPTION_KEY", k)
    assert crypto.decrypt(crypto.encrypt("alias-ok")) == "alias-ok"
