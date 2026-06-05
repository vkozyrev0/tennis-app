"""Officials accept/decline their assignments (self-service, migration 0038).

Uses a SECOND TestClient for the official so its login doesn't disturb the
primary admin session (every /auth/login rotates that user's sessions)."""
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


def _official_with_login():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Self", "last_name": "Serv " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    uname = "off_" + uuid.uuid4().hex[:8]
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": uname, "password": "pw"}), code=200)
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": "pw"}), 200)
    return o, sess


def _assign(oid):
    t = _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": oid}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-02", "working_as": "roving_official"}))
    return t, a


def test_official_accepts_and_td_sees_it():
    o, sess = _official_with_login()
    t, a = _assign(o["id"])
    # the official sees their assignment, pending by default
    mine = sess.get("/api/me/assignments").json()
    row = next(x for x in mine if x["id"] == a["id"])
    assert row["response_status"] == "pending" and row["responded_at"] is None
    assert len(row["days"]) == 1                      # full assignment detail

    # accept
    res = _ok(sess.post(f"/api/me/assignments/{a['id']}/respond", json={"status": "accepted"}), 200)
    assert res["response_status"] == "accepted" and res["responded_at"] is not None
    # the TD sees the status on the assignment
    td = next(x for x in client.get(f"/api/tournaments/{t['id']}/assignments").json() if x["id"] == a["id"])
    assert td["response_status"] == "accepted"

    # decline flips it; pending clears the timestamp
    assert _ok(sess.post(f"/api/me/assignments/{a['id']}/respond", json={"status": "declined"}), 200)["response_status"] == "declined"
    cleared = _ok(sess.post(f"/api/me/assignments/{a['id']}/respond", json={"status": "pending"}), 200)
    assert cleared["response_status"] == "pending" and cleared["responded_at"] is None


def test_cannot_respond_to_another_officials_assignment():
    o1, sess1 = _official_with_login()
    o2, _ = _official_with_login()
    _, a2 = _assign(o2["id"])                          # belongs to o2
    assert sess1.post(f"/api/me/assignments/{a2['id']}/respond",
                      json={"status": "accepted"}).status_code == 403


def test_invalid_status_rejected():
    o, sess = _official_with_login()
    _, a = _assign(o["id"])
    assert sess.post(f"/api/me/assignments/{a['id']}/respond",
                     json={"status": "maybe"}).status_code == 422


def test_report_totals_count_declines_and_pending():
    # One official declines, another stays pending, in the SAME tournament so the
    # TD's report surfaces both as actionable counts (re-staffing visibility).
    o1, s1 = _official_with_login()
    o2, _ = _official_with_login()
    t = _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    a1 = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o1["id"]}))
    a2 = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o2["id"]}))
    for a in (a1, a2):
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": "2026-06-02", "working_as": "roving_official"}))
    _ok(s1.post(f"/api/me/assignments/{a1['id']}/respond", json={"status": "declined"}), 200)
    totals = client.get(f"/api/tournaments/{t['id']}/reports/officials").json()["totals"]
    assert totals["declined_count"] == 1
    assert totals["pending_count"] == 1   # o2 never responded
