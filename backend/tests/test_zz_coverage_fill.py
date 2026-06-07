"""Coverage gap → invite: find certified officials to fill an uncovered
(role, date) cell, and fill it in one click.

`GET  /api/tournaments/{id}/coverage-candidates?role=&date=` lists certified
officials not already working that day here (with available / assigned_here /
busy_elsewhere flags).
`POST /api/tournaments/{id}/coverage-fill` assigns the official (if needed) and
adds the (date, role) day atomically.

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


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-07"}))


def _official(*certs):
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    for c in certs:
        _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": c}))
    return o


def _candidates(tid, role, date):
    return _ok(client.get(f"/api/tournaments/{tid}/coverage-candidates?role={role}&date={date}"), 200)


def _fill(tid, oid, date, role):
    return client.post(f"/api/tournaments/{tid}/coverage-fill",
                       json={"official_id": oid, "work_date": date, "working_as": role})


DAY = "2026-06-03"


def test_candidate_must_hold_the_role():
    t = _tournament()
    chair = _official("chair_umpire")
    rover = _official("roving_official")
    ids = [c["official_id"] for c in _candidates(t["id"], "chair_umpire", DAY)]
    assert chair["id"] in ids
    assert rover["id"] not in ids


def test_available_flag_and_ordering():
    t = _tournament()
    plain = _official("chair_umpire")
    avail = _official("chair_umpire")
    client.put(f"/api/tournaments/{t['id']}/availability",
               json={"official_id": avail["id"], "dates": [DAY], "hotel_needed": False})
    cands = _candidates(t["id"], "chair_umpire", DAY)
    by_id = {c["official_id"]: c for c in cands}
    assert by_id[avail["id"]]["available"] is True
    assert by_id[plain["id"]]["available"] is False
    # available officials sort first
    order = [c["official_id"] for c in cands]
    assert order.index(avail["id"]) < order.index(plain["id"])


def test_fill_creates_assignment_and_day():
    t = _tournament()
    o = _official("chair_umpire")
    s = _ok(_fill(t["id"], o["id"], DAY, "chair_umpire"))
    assert s["official_id"] == o["id"]
    assert [d["work_date"] for d in s["days"]] == [DAY]
    assert s["response_status"] == "pending"
    # now that they work DAY here, they drop out of the candidate list
    assert o["id"] not in [c["official_id"] for c in _candidates(t["id"], "chair_umpire", DAY)]


def test_fill_adds_day_to_existing_assignment():
    t = _tournament()
    o = _official("chair_umpire")
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    _ok(_fill(t["id"], o["id"], DAY, "chair_umpire"))
    # candidate now flagged assigned_here for a DIFFERENT day
    cands = _candidates(t["id"], "chair_umpire", "2026-06-04")
    me = next(c for c in cands if c["official_id"] == o["id"])
    assert me["assigned_here"] is True


def test_fill_rejects_uncertified_role():
    t = _tournament()
    o = _official("roving_official")
    assert _fill(t["id"], o["id"], DAY, "chair_umpire").status_code == 409


def test_fill_duplicate_day_409():
    t = _tournament()
    o = _official("chair_umpire")
    _ok(_fill(t["id"], o["id"], DAY, "chair_umpire"))
    assert _fill(t["id"], o["id"], DAY, "chair_umpire").status_code == 409


def test_candidates_bad_date_400():
    t = _tournament()
    assert client.get(
        f"/api/tournaments/{t['id']}/coverage-candidates?role=chair_umpire&date=not-a-date"
    ).status_code == 400


def test_busy_elsewhere_flag():
    t1, t2 = _tournament(), _tournament()
    o = _official("chair_umpire")
    _ok(_fill(t1["id"], o["id"], DAY, "chair_umpire"))  # now busy DAY in t1
    me = next(c for c in _candidates(t2["id"], "chair_umpire", DAY)
              if c["official_id"] == o["id"])
    assert me["busy_elsewhere"] is True
