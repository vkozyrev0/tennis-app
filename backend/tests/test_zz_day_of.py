"""Day-of operations (P4-1/P4-2): per-day actual status for officials (no_show
drops out of pay + the .ics feed) and the player check-in toggle."""
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
        "first_name": "Dayof", "last_name": "T" + uuid.uuid4().hex[:6]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications",
                    json={"cert_type": "roving_official"}))
    t = _ok(client.post("/api/tournaments", json={
        "name": "DO " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-09-01", "play_end_date": "2026-09-02"}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"]}))
    s = None
    for d in ("2026-09-01", "2026-09-02"):
        s = _ok(client.post(f"/api/assignments/{a['id']}/days",
                            json={"work_date": d, "working_as": "roving_official"}))
    return t, o, a, s


def test_no_show_drops_out_of_pay_and_back():
    t, o, a, s = _staffed()
    full_pay = s["pay"]
    assert full_pay > 0 and len(s["days"]) == 2
    assert all(d["actual_status"] == "planned" for d in s["days"])
    day = s["days"][0]

    s2 = _ok(client.put(f"/api/assignment-days/{day['id']}/status",
                        json={"actual_status": "no_show"}), 200)
    assert s2["no_show_days"] == 1
    assert next(d for d in s2["days"] if d["id"] == day["id"])["actual_status"] == "no_show"
    assert s2["pay"] == round(full_pay - day["rate_applied"], 2)   # day excluded
    assert s2["pay_audit"]["pay"] == s2["pay"]                     # snapshot refrozen
    assert any(d["actual_status"] == "no_show" for d in s2["pay_audit"]["days"])

    s3 = _ok(client.put(f"/api/assignment-days/{day['id']}/status",
                        json={"actual_status": "worked"}), 200)
    assert s3["pay"] == full_pay and s3["no_show_days"] == 0       # restored


def test_day_status_validation_and_404():
    t, o, a, s = _staffed()
    r = client.put(f"/api/assignment-days/{s['days'][0]['id']}/status",
                   json={"actual_status": "vanished"})
    assert r.status_code == 422
    r = client.put("/api/assignment-days/99999999/status",
                   json={"actual_status": "worked"})
    assert r.status_code == 404


def test_no_show_day_leaves_the_ics_feed():
    t, o, a, s = _staffed()
    ics = client.get(f"/api/officials/{o['id']}/schedule.ics").text
    assert ics.count("BEGIN:VEVENT") == 2
    _ok(client.put(f"/api/assignment-days/{s['days'][0]['id']}/status",
                   json={"actual_status": "no_show"}), 200)
    ics = client.get(f"/api/officials/{o['id']}/schedule.ics").text
    assert ics.count("BEGIN:VEVENT") == 1


def test_player_check_in_toggle():
    t = _ok(client.post("/api/tournaments", json={
        "name": "CI " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-09-01", "play_end_date": "2026-09-02"}))
    p = _ok(client.post("/api/players", json={
        "usta_number": str(uuid.uuid4().int)[:10],
        "first_name": "Check", "last_name": "In", "gender": "female"}))
    e = _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected"}))
    assert not e.get("signed_in")

    e2 = _ok(client.put(f"/api/roster/{e['id']}/signin", json={"signed_in": True}), 200)
    assert e2["signed_in"] is True
    roster = _ok(client.get(f"/api/tournaments/{t['id']}/players"), 200)
    assert next(x for x in roster if x["id"] == e["id"])["signed_in"] is True

    e3 = _ok(client.put(f"/api/roster/{e['id']}/signin", json={"signed_in": False}), 200)
    assert e3["signed_in"] is False
    assert client.put("/api/roster/99999999/signin",
                      json={"signed_in": True}).status_code == 404
