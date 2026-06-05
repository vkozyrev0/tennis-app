"""PII hardening H1: the boot-time DB-config guard (docs/pii-hardening-plan.md).

Pure unit tests on Settings.validate() — no DB, no TestClient — so they run even
when Postgres is down.
"""
import pytest

from app.config import Settings


def _settings(**over):
    s = Settings()
    for k, v in over.items():
        setattr(s, k, v)
    return s


def test_dev_is_noop_even_with_default_creds():
    # the local POC default: ENV=dev, postgres/postgres, sslmode=prefer
    _settings(env="dev", user="postgres", password="postgres", sslmode="prefer").validate()
    for e in ("development", "local", "test", "ci"):
        _settings(env=e, user="postgres", password="postgres").validate()


def test_prod_rejects_default_password():
    with pytest.raises(RuntimeError, match="default Postgres"):
        _settings(env="prod", user="app", password="postgres",
                  sslmode="require").validate()


def test_prod_rejects_default_superuser():
    with pytest.raises(RuntimeError, match="default Postgres"):
        _settings(env="prod", user="postgres", password="s3cret",
                  sslmode="require").validate()


def test_prod_rejects_non_tls():
    with pytest.raises(RuntimeError, match="TLS"):
        _settings(env="prod", user="app", password="s3cret",
                  sslmode="prefer").validate()
    with pytest.raises(RuntimeError, match="TLS"):
        _settings(env="prod", user="app", password="s3cret",
                  sslmode="disable").validate()


def test_prod_rejects_dev_encryption_key(monkeypatch):
    # secure DB but the POC dev Fernet key → still refused (PII H2)
    monkeypatch.delenv("PII_ENCRYPTION_KEY", raising=False)
    with pytest.raises(RuntimeError, match="PII_ENCRYPTION_KEY"):
        _settings(env="prod", user="app", password="s3cret", sslmode="require").validate()


def test_prod_passes_with_secure_config(monkeypatch):
    monkeypatch.setenv("PII_ENCRYPTION_KEY", "a-real-non-default-key-set-from-the-environment")
    for mode in ("require", "verify-ca", "verify-full"):
        _settings(env="prod", user="courtops_app", password="a-real-secret",
                  sslmode=mode).validate()


def test_dsn_includes_sslmode():
    assert "sslmode=require" in _settings(sslmode="require").dsn
    assert "sslmode=require" in _settings(sslmode="require").admin_dsn
