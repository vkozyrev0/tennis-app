"""Assigned officials without a self-service login (GET .../officials-without-login).

They can't accept/decline, so their assignments sit pending — flag them.
Named to sort last."""
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
    return r.json()


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _official(email=None):
    body = {"first_name": "NoL", "last_name": "Ogin " + uuid.uuid4().hex[:5]}
    if email:
        body["email"] = email
    return _ok(client.post("/api/officials", json=body))


def _assign(tid, oid):
    return _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))


def _list(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/officials-without-login"), 200)


def test_assigned_without_login_flagged():
    t = _tournament()
    o = _official(email="x@example.com")
    _assign(t["id"], o["id"])
    out = _list(t["id"])
    assert out["count"] == 1
    row = out["officials"][0]
    assert row["official_id"] == o["id"]
    assert row["has_email"] is True
    assert row["response_status"] == "pending"


def test_official_with_login_excluded():
    t = _tournament()
    o = _official()
    _assign(t["id"], o["id"])
    # give them a login → they drop off the list
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": "nl_" + uuid.uuid4().hex[:8], "password": "pw"}), code=200)
    assert _list(t["id"])["count"] == 0


def test_unassigned_official_not_listed():
    t = _tournament()
    _official()  # exists but not assigned to this tournament
    assert _list(t["id"])["count"] == 0


def test_no_login_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/officials-without-login").status_code == 404
