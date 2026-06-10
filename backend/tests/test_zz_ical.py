"""iCal schedule export — GET /api/officials/{id}/schedule.ics (admin) and
GET /api/me/schedule.ics (official portal). One all-day VEVENT per assignment
day; declined assignments are skipped; pending = TENTATIVE, accepted = CONFIRMED.

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


def _official_with_login():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Cal", "last_name": "Ical " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    uname = "ics_" + uuid.uuid4().hex[:8]
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": uname, "password": "pw"}), code=200)
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": "pw"}), 200)
    return o, sess


def _assign(oid, days=("2026-06-02", "2026-06-03")):
    t = _ok(client.post("/api/tournaments", json={
        "name": "Ical T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": oid}))
    for d in days:
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": d, "working_as": "roving_official"}))
    return t, a


def test_admin_ics_one_event_per_day():
    o, _sess = _official_with_login()
    t, _a = _assign(o["id"])
    r = client.get(f"/api/officials/{o['id']}/schedule.ics")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/calendar")
    assert "attachment" in r.headers["content-disposition"]
    body = r.text
    assert body.count("BEGIN:VEVENT") == 2
    assert "DTSTART;VALUE=DATE:20260602" in body
    assert "DTSTART;VALUE=DATE:20260603" in body
    assert t["name"].replace(",", "\\,") in body          # tournament in SUMMARY
    assert "STATUS:TENTATIVE" in body                      # pending by default
    assert body.endswith("END:VCALENDAR\r\n")              # RFC 5545 CRLF


def test_accept_flips_status_and_decline_drops_events():
    o, sess = _official_with_login()
    _t, a = _assign(o["id"])
    _ok(sess.post(f"/api/me/assignments/{a['id']}/respond", json={"status": "accepted"}), 200)
    body = client.get(f"/api/officials/{o['id']}/schedule.ics").text
    assert "STATUS:CONFIRMED" in body and "STATUS:TENTATIVE" not in body
    _ok(sess.post(f"/api/me/assignments/{a['id']}/respond", json={"status": "declined"}), 200)
    body = client.get(f"/api/officials/{o['id']}/schedule.ics").text
    assert body.count("BEGIN:VEVENT") == 0                 # declined → no events


def test_me_ics_is_own_schedule_only():
    o, sess = _official_with_login()
    _assign(o["id"], days=("2026-06-02",))
    r = sess.get("/api/me/schedule.ics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/calendar")
    assert r.text.count("BEGIN:VEVENT") == 1
    # admin account has no linked official → 403
    assert client.get("/api/me/schedule.ics").status_code == 403


def test_admin_ics_404_unknown_official():
    assert client.get("/api/officials/999999/schedule.ics").status_code == 404
