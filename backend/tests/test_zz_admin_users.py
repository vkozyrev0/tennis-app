"""Multi-user TD access (D8): admin account management.

Named to sort last; logs in lazily before each test (other modules log in too).
Note: every /auth/login rotates sessions for that username, so we use a SECOND
TestClient instance for the new admin to avoid disturbing the primary admin
session this module relies on.
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


@pytest.fixture(autouse=True)
def _ensure_admin_session():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json() if r.content else None


def test_create_list_and_login_as_new_admin():
    uname = "td_" + uuid.uuid4().hex[:8]
    u = _ok(client.post("/api/admin/users", json={"username": uname, "password": "pw1"}))
    assert u["role"] == "admin" and u["username"] == uname
    assert any(a["username"] == uname for a in client.get("/api/admin/users").json())
    # the new admin can log in (separate client so the primary session is intact)
    other = TestClient(app)
    assert other.post("/api/auth/login", json={"username": uname, "password": "pw1"}).status_code == 200
    assert other.get("/api/tournaments").status_code == 200  # admin-only route works
    # cleanup
    _ok(client.delete(f"/api/admin/users/{u['id']}"), 204)


def test_duplicate_username_rejected():
    uname = "dup_" + uuid.uuid4().hex[:8]
    u = _ok(client.post("/api/admin/users", json={"username": uname, "password": "x"}))
    assert client.post("/api/admin/users", json={"username": uname, "password": "y"}).status_code == 409
    _ok(client.delete(f"/api/admin/users/{u['id']}"), 204)


def test_cannot_delete_self():
    me = client.get("/api/auth/me").json()
    # find my own user id from the list
    mine = next(a for a in client.get("/api/admin/users").json() if a["username"] == me["username"])
    assert client.delete(f"/api/admin/users/{mine['id']}").status_code == 400


def test_password_reset_invalidates_sessions():
    uname = "rst_" + uuid.uuid4().hex[:8]
    u = _ok(client.post("/api/admin/users", json={"username": uname, "password": "old"}))
    other = TestClient(app)
    _ok(other.post("/api/auth/login", json={"username": uname, "password": "old"}), 200)
    # admin resets the password → the old session is invalidated, old password fails
    _ok(client.post(f"/api/admin/users/{u['id']}/password", json={"password": "new"}), 204)
    assert other.get("/api/tournaments").status_code == 401
    assert other.post("/api/auth/login", json={"username": uname, "password": "old"}).status_code == 401
    assert other.post("/api/auth/login", json={"username": uname, "password": "new"}).status_code == 200
    _ok(client.delete(f"/api/admin/users/{u['id']}"), 204)


def test_delete_and_missing_admin_404():
    uname = "del_" + uuid.uuid4().hex[:8]
    u = _ok(client.post("/api/admin/users", json={"username": uname, "password": "x"}))
    _ok(client.delete(f"/api/admin/users/{u['id']}"), 204)
    assert client.delete(f"/api/admin/users/{u['id']}").status_code == 404
    assert client.post(f"/api/admin/users/{u['id']}/password", json={"password": "z"}).status_code == 404
