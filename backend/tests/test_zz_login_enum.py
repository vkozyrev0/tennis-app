"""Login user-enumeration defenses (POST /api/auth/login).

An attacker probing usernames must not be able to tell a nonexistent account
from a real one with a wrong password — neither by the response body NOR by
timing. The body is asserted here; the timing equalization (a missing user
still runs one PBKDF2 against a dummy hash) is asserted directly against the
call, so the regression guard does not depend on wall-clock noise.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


def test_unknown_user_and_wrong_password_return_identical_response():
    c = TestClient(app)
    r_unknown = c.post("/api/auth/login",
                       json={"username": "nobody_" + uuid.uuid4().hex, "password": "x"})
    r_wrong = c.post("/api/auth/login",
                     json={"username": "admin", "password": "definitely-not-it"})
    assert r_unknown.status_code == 401 and r_wrong.status_code == 401
    # Same generic detail — the body must not reveal which input was wrong.
    assert r_unknown.json()["detail"] == r_wrong.json()["detail"]


def test_unknown_user_runs_the_dummy_hash_verify(monkeypatch):
    """Regression guard for the timing fix: a missing user must run PBKDF2
    against the dummy hash. Assert the call directly instead of comparing
    wall-clock times, which is flaky under CI jitter (D32)."""
    from app.routers import auth as auth_router

    calls = []

    def spy(pw, hashed):
        calls.append(hashed)
        return False

    monkeypatch.setattr(auth_router, "verify_pw", spy)
    c = TestClient(app)
    r = c.post("/api/auth/login",
               json={"username": "ghost_" + uuid.uuid4().hex, "password": "x"})
    assert r.status_code == 401
    assert calls == [auth_router._DUMMY_HASH]
