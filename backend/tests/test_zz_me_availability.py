"""Official self-service availability (PUT/GET /api/me/availability/{id}).

An official sets their OWN available dates for a tournament; the write rejects
dates outside the play window. Named to sort last.

Uses a SECOND TestClient for the official so its login doesn't disturb admin."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)  # admin

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


def _official_with_login():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ava", "last_name": "Self " + uuid.uuid4().hex[:5]}))
    uname = "ava_" + uuid.uuid4().hex[:8]
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": uname, "password": "pw"}), code=200)
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": "pw"}), 200)
    return o, sess


def test_official_sets_own_availability():
    t = _tournament()
    o, sess = _official_with_login()
    r = sess.put(f"/api/me/availability/{t['id']}",
                 json={"dates": ["2026-06-01", "2026-06-03"], "hotel_needed": True})
    assert r.status_code == 200, r.text
    got = _ok(sess.get(f"/api/me/availability/{t['id']}"), 200)
    assert got["dates"] == ["2026-06-01", "2026-06-03"]
    assert got["hotel_needed"] is True
    # and the TD sees it on the admin availability list
    adm = client.get(f"/api/tournaments/{t['id']}/availability").json()
    assert any(a["official_id"] == o["id"] for a in adm)


def test_out_of_window_date_rejected():
    t = _tournament()
    _o, sess = _official_with_login()
    r = sess.put(f"/api/me/availability/{t['id']}",
                 json={"dates": ["2026-07-15"], "hotel_needed": False})
    assert r.status_code == 400
    assert "window" in r.json()["detail"].lower()


def test_admin_account_cannot_use_me_availability():
    t = _tournament()
    # the admin account has no linked official → 403
    assert client.put(f"/api/me/availability/{t['id']}",
                      json={"dates": ["2026-06-01"], "hotel_needed": False}).status_code == 403
