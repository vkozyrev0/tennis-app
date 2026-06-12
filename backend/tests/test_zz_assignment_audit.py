"""Assignment change audit (P4-5, migration 0044): WHO did WHAT, WHEN — and the
trail survives the assignment being deleted (denormalized identity, FK NULL).

Uses a SECOND TestClient for the official respond-path so its login doesn't
rotate the admin session."""
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


def _staffed():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Aud", "last_name": "Trail" + uuid.uuid4().hex[:6]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications",
                    json={"cert_type": "roving_official"}))
    t = _ok(client.post("/api/tournaments", json={
        "name": "AU " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-12-01", "play_end_date": "2026-12-02"}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"]}))
    return t, o, a


def _trail(aid):
    return _ok(client.get(f"/api/assignments/{aid}/audit"), 200)


def test_lifecycle_actions_are_recorded_with_actor():
    t, o, a = _staffed()
    s = _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": "2026-12-01", "working_as": "roving_official"}))
    day = s["days"][0]
    _ok(client.put(f"/api/assignment-days/{day['id']}/status",
                   json={"actual_status": "worked"}), 200)
    assert client.delete(f"/api/assignment-days/{day['id']}").status_code == 204

    rows = _trail(a["id"])
    actions = [r["action"] for r in rows]            # newest first
    assert actions == ["day_removed", "day_status", "day_added", "created"]
    assert all(r["changed_by"] == "admin" for r in rows)
    st = next(r for r in rows if r["action"] == "day_status")
    assert st["detail"] == {"work_date": "2026-12-01", "actual_status": "worked"}
    add = next(r for r in rows if r["action"] == "day_added")
    assert add["detail"]["working_as"] == "roving_official"


def test_official_response_is_attributed_to_their_login():
    t, o, a = _staffed()
    uname = "aud" + uuid.uuid4().hex[:8]
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": uname, "password": "pw"}), 200)
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": "pw"}), 200)
    _ok(sess.post(f"/api/me/assignments/{a['id']}/respond",
                  json={"status": "accepted"}), 200)

    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    rows = _trail(a["id"])
    resp = next(r for r in rows if r["action"] == "response")
    assert resp["changed_by"] == uname
    assert resp["detail"] == {"status": "accepted"}


def test_trail_survives_assignment_deletion():
    from app.db import get_conn
    t, o, a = _staffed()
    assert client.delete(f"/api/assignments/{a['id']}").status_code == 204
    # the per-assignment endpoint now finds nothing (FK nulled)...
    assert _trail(a["id"]) == []
    # ...but the rows survive with denormalized identity, queryable by tournament.
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT action, official_name, changed_by FROM assignment_audit "
                        "WHERE tournament_id = %s ORDER BY changed_at", (t["id"],))
            rows = cur.fetchall()
    finally:
        conn.close()
    assert [r["action"] for r in rows] == ["created", "deleted"]
    assert all(o["last_name"] in r["official_name"] for r in rows)
    assert rows[-1]["changed_by"] == "admin"
