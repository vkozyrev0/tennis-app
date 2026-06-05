"""Self-service change-own-password (POST /api/auth/change-password).

Works for any logged-in user. To avoid disturbing the shared `admin/admin`
login that every other test module relies on, this creates a DEDICATED admin
account and drives the change through its own TestClient session.

Named to sort last (same rationale as the other test_zz modules)."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)  # the shared admin

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


@pytest.fixture(autouse=True)
def _ensure_admin_session():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _fresh_admin(pw="origpw123"):
    """Create a throwaway admin + return (username, a logged-in TestClient)."""
    uname = "pw_" + uuid.uuid4().hex[:10]
    _ok(client.post("/api/admin/users", json={"username": uname, "password": pw}))
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": pw}), 200)
    return uname, sess


def test_change_password_happy_path_and_old_password_dies():
    uname, sess = _fresh_admin("origpw123")
    r = sess.post("/api/auth/change-password",
                  json={"current_password": "origpw123", "new_password": "brandnew456"})
    assert r.status_code == 200, r.text

    # the current session stays alive (caller not logged out)
    assert sess.get("/api/auth/me").status_code == 200

    # old password no longer logs in; new one does
    fresh = TestClient(app)
    assert fresh.post("/api/auth/login",
                      json={"username": uname, "password": "origpw123"}).status_code == 401
    assert fresh.post("/api/auth/login",
                      json={"username": uname, "password": "brandnew456"}).status_code == 200


def test_wrong_current_password_rejected():
    _, sess = _fresh_admin("origpw123")
    r = sess.post("/api/auth/change-password",
                  json={"current_password": "WRONG", "new_password": "brandnew456"})
    assert r.status_code == 400
    assert "current password" in r.json()["detail"].lower()


def test_new_password_must_differ():
    _, sess = _fresh_admin("samepw1234")
    r = sess.post("/api/auth/change-password",
                  json={"current_password": "samepw1234", "new_password": "samepw1234"})
    assert r.status_code == 400
    assert "differ" in r.json()["detail"].lower()


def test_new_password_minimum_length_enforced():
    _, sess = _fresh_admin("origpw123")
    r = sess.post("/api/auth/change-password",
                  json={"current_password": "origpw123", "new_password": "short"})
    assert r.status_code == 422   # Field(min_length=8)


def test_requires_authentication():
    anon = TestClient(app)
    assert anon.post("/api/auth/change-password",
                     json={"current_password": "x", "new_password": "brandnew456"}).status_code == 401
