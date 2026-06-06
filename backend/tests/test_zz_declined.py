"""Declined-assignment alert list (GET .../declined).

The named, actionable re-staffing list: each declined assignment with the
official, the slot (site + days/roles), and when they declined. Named to sort
last.

Uses a SECOND TestClient for the official (its login mustn't disturb admin's)."""
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
        "first_name": "Dec", "last_name": "Lined " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    uname = "off_" + uuid.uuid4().hex[:8]
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": uname, "password": "pw"}), code=200)
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": "pw"}), 200)
    return o, sess


def _declined(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/declined"), 200)


def test_declined_listed_with_slot_detail():
    t = _tournament()
    o, sess = _official_with_login()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-02", "working_as": "roving_official"}))
    # official declines
    _ok(sess.post(f"/api/me/assignments/{a['id']}/respond", json={"status": "declined"}), 200)
    d = _declined(t["id"])
    assert d["count"] == 1
    row = d["declined"][0]
    assert row["assignment_id"] == a["id"]
    assert row["official_name"].startswith("Lined")
    assert row["day_count"] == 1
    assert row["days"][0]["work_date"] == "2026-06-02"
    assert row["responded_at"] is not None


def test_pending_and_accepted_not_listed():
    t = _tournament()
    o1, _ = _official_with_login()
    o2, s2 = _official_with_login()
    _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o1["id"]}))  # pending
    a2 = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o2["id"]}))
    _ok(s2.post(f"/api/me/assignments/{a2['id']}/respond", json={"status": "accepted"}), 200)
    assert _declined(t["id"])["count"] == 0


def test_declined_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/declined").status_code == 404
