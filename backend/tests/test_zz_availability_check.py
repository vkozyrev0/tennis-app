"""Assignment availability check (audit §Availability).

The TD collects each official's available dates per tournament. Assigning a day
the official did NOT declare available is surfaced as a flag — never a block
(mirrors work_date_out_of_window / hotel-date policy). The flag is suppressed
entirely when the official declared nothing (absence of data is not a decline).

Named to sort last so its admin logins don't pre-empt a still-running module
(same rationale as test_zz_conflicts).
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
    return r.json()


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-07"}))


def _official_with_cert():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications",
                    json={"cert_type": "roving_official"}))
    return o


def _assign(tid, oid, site_id=None):
    if site_id is not None:
        linked = [s["id"] for s in client.get(f"/api/tournaments/{tid}/sites").json()]
        if site_id not in linked:
            _ok(client.put(f"/api/tournaments/{tid}/sites",
                           json={"site_ids": linked + [site_id]}), 200)
    return _ok(client.post(f"/api/tournaments/{tid}/assignments",
                           json={"official_id": oid, "site_id": site_id}))


def _add_day(aid, work_date):
    return _ok(client.post(f"/api/assignments/{aid}/days",
                           json={"work_date": work_date, "working_as": "roving_official"}))


def _set_availability(tid, oid, dates):
    r = client.put(f"/api/tournaments/{tid}/availability",
                   json={"official_id": oid, "dates": dates, "hotel_needed": False})
    assert r.status_code == 200, r.text


def _summary(tid, aid):
    return next(a for a in client.get(f"/api/tournaments/{tid}/assignments").json()
                if a["id"] == aid)


def test_no_availability_data_means_no_flag():
    o = _official_with_cert()
    t = _tournament()
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02")
    s = _summary(t["id"], a["id"])
    assert s["has_availability_data"] is False
    assert s["days_outside_availability"] == []
    assert s["available_dates"] == []
    assert all(d["outside_availability"] is False for d in s["days"])


def test_day_outside_declared_availability_is_flagged():
    o = _official_with_cert()
    t = _tournament()
    _set_availability(t["id"], o["id"], ["2026-06-02", "2026-06-03"])
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02")   # declared → fine
    _add_day(a["id"], "2026-06-05")   # NOT declared → flagged
    s = _summary(t["id"], a["id"])
    assert s["has_availability_data"] is True
    assert s["days_outside_availability"] == ["2026-06-05"]
    assert sorted(s["available_dates"]) == ["2026-06-02", "2026-06-03"]
    by_date = {d["work_date"]: d["outside_availability"] for d in s["days"]}
    assert by_date["2026-06-02"] is False
    assert by_date["2026-06-05"] is True


def test_all_days_within_availability_no_flag():
    o = _official_with_cert()
    t = _tournament()
    _set_availability(t["id"], o["id"], ["2026-06-02", "2026-06-03"])
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02")
    _add_day(a["id"], "2026-06-03")
    s = _summary(t["id"], a["id"])
    assert s["has_availability_data"] is True
    assert s["days_outside_availability"] == []
    assert all(d["outside_availability"] is False for d in s["days"])


def test_report_totals_count_availability_alerts():
    o = _official_with_cert()
    t = _tournament()
    _set_availability(t["id"], o["id"], ["2026-06-02"])
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-04")   # outside availability
    rep = client.get(f"/api/tournaments/{t['id']}/reports/officials").json()
    assert rep["totals"]["availability_count"] >= 1
