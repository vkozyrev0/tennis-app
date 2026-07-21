"""Thin COPPA policy (audit D16): under-13 gate + machine-readable policy.

Age math and env gating are pure unit tests (no DB). API 403 path needs Postgres.
"""
from datetime import date

import pytest
from fastapi import HTTPException

from app import coppa


def test_age_years_day_precision():
    # Fixed "today" so the suite is calendar-stable.
    as_of = date(2026, 7, 20)
    assert coppa.age_years("2013-07-21", as_of=as_of) == 12  # day before birthday
    assert coppa.age_years("2013-07-20", as_of=as_of) == 13  # birthday today
    assert coppa.age_years("2010-01-01", as_of=as_of) == 16


def test_year_precision_is_conservative():
    """Year-only → treat as Dec 31 so we don't under-count under-13."""
    as_of = date(2026, 7, 20)
    # Born sometime in 2013: youngest interpretation still 12 on mid-2026.
    assert coppa.is_under13("2013-01-01", precision="year", as_of=as_of) is True
    # Born 2012 → even Dec 31 2012 is age 13 by July 2026.
    assert coppa.is_under13("2012-01-01", precision="year", as_of=as_of) is False


def test_missing_birthdate_not_under13():
    assert coppa.is_under13(None) is False
    assert coppa.age_years(None) is None


def test_allow_under13_auto_dev_vs_prod(monkeypatch):
    # is_prod() reads live ENV (not the Settings singleton), so monkeypatch the env var.
    monkeypatch.delenv("ALLOW_UNDER13_PII", raising=False)
    monkeypatch.setenv("ENV", "dev")
    assert coppa.allow_under13_pii() is True

    monkeypatch.setenv("ENV", "prod")
    assert coppa.allow_under13_pii() is False

    monkeypatch.setenv("ALLOW_UNDER13_PII", "1")
    assert coppa.allow_under13_pii() is True

    monkeypatch.setenv("ALLOW_UNDER13_PII", "0")
    monkeypatch.setenv("ENV", "dev")
    assert coppa.allow_under13_pii() is False


def test_refuse_raises_when_blocked(monkeypatch):
    monkeypatch.setenv("ALLOW_UNDER13_PII", "0")
    monkeypatch.setenv("ENV", "dev")
    with pytest.raises(HTTPException) as ei:
        coppa.refuse_under13_birthdate("2014-03-15", as_of=date(2026, 7, 20))
    assert ei.value.status_code == 403
    assert "under-13" in ei.value.detail.lower() or "ALLOW_UNDER13_PII" in ei.value.detail

    # Allowed path is silent
    monkeypatch.setenv("ALLOW_UNDER13_PII", "1")
    coppa.refuse_under13_birthdate("2014-03-15", as_of=date(2026, 7, 20))

    # Age ≥ 13 never raises even when blocked
    monkeypatch.setenv("ALLOW_UNDER13_PII", "0")
    coppa.refuse_under13_birthdate("2010-01-01", as_of=date(2026, 7, 20))


def test_policy_shape():
    p = coppa.policy()
    assert p["under13_age"] == 13
    assert "player.first_name" in p["decision"]["residual_plaintext"]
    assert "player.birthdate" in p["decision"]["encrypted_at_rest"]
    assert p["doc"] == "docs/coppa-policy.md"
    assert isinstance(p["allow_under13_pii"], bool)
    assert "release_gates_before_real_under13" in p


def test_api_policy_and_under13_create_blocked(monkeypatch):
    """Integration: needs Postgres. Skips cleanly when DB is down."""
    import uuid

    from fastapi.testclient import TestClient

    from app.config import settings
    from app.main import app

    client = TestClient(app)
    try:
        if client.get("/api/health").json().get("db") != "ok":
            pytest.skip("Postgres not reachable / not migrated")
    except Exception:
        pytest.skip("Postgres not reachable / not migrated")

    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    r = client.get("/api/coppa/policy")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["under13_age"] == 13
    assert "encrypted_at_rest" in body["decision"]

    # Force deny regardless of ENV so this is stable in CI/dev.
    monkeypatch.setenv("ALLOW_UNDER13_PII", "0")
    monkeypatch.setattr(settings, "env", "dev")
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    bad = client.post("/api/players", json={
        "usta_number": usta, "first_name": "Kid", "last_name": "Under",
        "gender": "female", "birthdate": "2015-06-01",
    })
    assert bad.status_code == 403, bad.text
    assert "ALLOW_UNDER13_PII" in bad.json()["detail"] or "under-13" in bad.json()["detail"].lower()

    # 13+ still works
    ok = client.post("/api/players", json={
        "usta_number": str(uuid.uuid4().int % 10**10).zfill(10),
        "first_name": "Teen", "last_name": "Ok",
        "gender": "female", "birthdate": "2010-01-01",
    })
    assert ok.status_code == 201, ok.text
