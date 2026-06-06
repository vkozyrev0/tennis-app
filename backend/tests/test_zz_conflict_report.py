"""Assignment conflict report (GET .../conflicts).

Aggregates every staffing conflict for a tournament in one place: cross-
tournament double-bookings (hard = different site same day), uncertified worked
days, days outside a declared-available window, days outside the play window,
and hotel-date mismatches.

Named to sort last (same rationale as the other test_zz modules)."""
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


def _site():
    return _ok(client.post("/api/sites", json={"name": "Site " + uuid.uuid4().hex[:6]}))


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _official(*certs):
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    for c in certs:
        _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": c}))
    return o


def _assign(tid, oid, site_id=None):
    return _ok(client.post(f"/api/tournaments/{tid}/assignments",
                           json={"official_id": oid, "site_id": site_id}))


def _add_day(aid, date, role="roving_official"):
    return _ok(client.post(f"/api/assignments/{aid}/days",
                           json={"work_date": date, "working_as": role}))


def _report(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/conflicts"), 200)


def test_clean_tournament_has_no_conflicts():
    t = _tournament()
    o = _official("roving_official")
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02")
    rep = _report(t["id"])
    assert rep["counts"]["total"] == 0
    assert rep["double_bookings"] == []


def test_hard_double_booking_listed():
    o = _official("roving_official")
    sa, sb = _site(), _site()
    t1, t2 = _tournament(), _tournament()
    a1 = _assign(t1["id"], o["id"], sa["id"])
    a2 = _assign(t2["id"], o["id"], sb["id"])
    _add_day(a1["id"], "2026-06-02")
    _add_day(a2["id"], "2026-06-02")  # same day, different site → hard
    rep = _report(t1["id"])
    assert rep["counts"]["double_bookings"] == 1
    assert rep["counts"]["hard_double_bookings"] == 1
    db = rep["double_bookings"][0]
    assert db["official_id"] == o["id"]
    assert db["work_date"] == "2026-06-02"
    assert db["different_site"] is True
    assert db["other_tournament_id"] == t2["id"]


def test_uncertified_day_listed():
    # An official with NO certs on file passes the add-day guard but every worked
    # day is flagged uncertified (the report surfaces these for the TD to fix).
    t = _tournament()
    o = _official()  # no certifications
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02", role="chair_umpire")
    rep = _report(t["id"])
    assert rep["counts"]["uncertified"] == 1
    u = rep["uncertified"][0]
    assert u["working_as"] == "chair_umpire"
    assert u["work_date"] == "2026-06-02"


def test_outside_availability_listed():
    t = _tournament()
    o = _official("roving_official")
    # declares available 06-01 only, but is worked 06-02
    client.put(f"/api/tournaments/{t['id']}/availability",
               json={"official_id": o["id"], "dates": ["2026-06-01"], "hotel_needed": False})
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02")
    rep = _report(t["id"])
    assert rep["counts"]["outside_availability"] == 1
    assert rep["outside_availability"][0]["work_date"] == "2026-06-02"


def test_out_of_window_listed():
    t = _tournament()
    o = _official("roving_official")
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-07-15")  # well outside the 06-01..06-04 window
    rep = _report(t["id"])
    assert rep["counts"]["out_of_window"] == 1
    assert rep["out_of_window"][0]["official_id"] == o["id"]


def test_report_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/conflicts").status_code == 404
