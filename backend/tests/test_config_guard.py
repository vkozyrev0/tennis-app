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


def test_secure_cookie_defaults_on_in_prod(monkeypatch):
    """B1: Secure cookie auto-on when ENV is shared/hosted; override still works."""
    from app.routers import auth as auth_mod

    monkeypatch.delenv("COURTOPS_SECURE_COOKIE", raising=False)
    monkeypatch.setenv("ENV", "prod")
    assert auth_mod._secure_cookie() is True
    monkeypatch.setenv("ENV", "dev")
    assert auth_mod._secure_cookie() is False
    monkeypatch.setenv("COURTOPS_SECURE_COOKIE", "1")
    monkeypatch.setenv("ENV", "dev")
    assert auth_mod._secure_cookie() is True
    monkeypatch.setenv("COURTOPS_SECURE_COOKIE", "0")
    monkeypatch.setenv("ENV", "prod")
    assert auth_mod._secure_cookie() is False


def test_session_ttl_clamped(monkeypatch):
    from app.routers import auth as auth_mod

    monkeypatch.delenv("COURTOPS_SESSION_DAYS", raising=False)
    monkeypatch.setenv("ENV", "dev")
    assert auth_mod._session_ttl_sql() == "30 days"
    monkeypatch.setenv("ENV", "prod")
    assert auth_mod._session_ttl_sql() == "7 days"  # D3 prod default
    monkeypatch.setenv("COURTOPS_SESSION_DAYS", "14")
    assert auth_mod._session_ttl_sql() == "14 days"  # explicit wins in prod too
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.setenv("COURTOPS_SESSION_DAYS", "7")
    assert auth_mod._session_ttl_sql() == "7 days"
    monkeypatch.setenv("COURTOPS_SESSION_DAYS", "0")
    assert auth_mod._session_ttl_sql() == "1 days"
    monkeypatch.setenv("COURTOPS_SESSION_DAYS", "999")
    assert auth_mod._session_ttl_sql() == "90 days"


def test_password_change_required_enforcement(monkeypatch):
    """D3: must_change_password only blocks API when ENV=prod (or force flag)."""
    from app.security import password_change_required

    u = {"must_change_password": True}
    monkeypatch.delenv("COURTOPS_FORCE_PASSWORD_CHANGE", raising=False)
    monkeypatch.setenv("ENV", "dev")
    assert password_change_required(u) is False
    monkeypatch.setenv("ENV", "prod")
    assert password_change_required(u) is True
    monkeypatch.setenv("COURTOPS_FORCE_PASSWORD_CHANGE", "0")
    assert password_change_required(u) is False
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.setenv("COURTOPS_FORCE_PASSWORD_CHANGE", "1")
    assert password_change_required(u) is True
    assert password_change_required({"must_change_password": False}) is False
