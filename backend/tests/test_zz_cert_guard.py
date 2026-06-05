"""Per-day certification guard (audit §3.4 — flag, not block).

The assign picker filters roles to those an official holds, but manual/edit
paths and post-assignment cert removal can leave a day whose role the official
isn't certified for. _summary flags such days (per-day `uncertified`, plus
`uncertified_days`/`has_uncertified`) and the report rolls up a count.

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
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _official(*cert_types):
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    certs = {}
    for ct in cert_types:
        certs[ct] = _ok(client.post(f"/api/officials/{o['id']}/certifications",
                                    json={"cert_type": ct}))["id"]
    return o, certs


def _assign(tid, oid):
    return _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))


def _add_day(aid, work_date, role):
    return _ok(client.post(f"/api/assignments/{aid}/days",
                           json={"work_date": work_date, "working_as": role}))


def _summary(tid, aid):
    return next(a for a in client.get(f"/api/tournaments/{tid}/assignments").json()
                if a["id"] == aid)


def test_certified_role_is_not_flagged():
    t = _tournament()
    o, _ = _official("roving_official")
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02", "roving_official")
    s = _summary(t["id"], a["id"])
    assert s["has_uncertified"] is False
    assert s["uncertified_days"] == []
    assert "roving_official" in s["held_certs"]
    assert all(d["uncertified"] is False for d in s["days"])


def test_add_day_blocks_uncertified_role():
    # The assign path itself hard-blocks an uncertified role (409) — the picker
    # filters, and the backend enforces. The flag below exists for the OTHER
    # path: a cert removed after the day was booked (next test).
    t = _tournament()
    o, _ = _official("roving_official")           # holds roving only
    a = _assign(t["id"], o["id"])
    r = client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-03", "working_as": "chair_umpire"})
    assert r.status_code == 409, r.text
    assert "not certified" in r.json()["detail"].lower()


def test_uncertified_day_flagged_after_cert_removed():
    t = _tournament()
    o, certs = _official("roving_official", "chair_umpire")   # holds both
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02", "roving_official")
    _add_day(a["id"], "2026-06-03", "chair_umpire")
    assert _summary(t["id"], a["id"])["has_uncertified"] is False
    # TD revokes the chair cert → the 06-03 day is now uncertified, 06-02 isn't
    assert client.delete(f"/api/certifications/{certs['chair_umpire']}").status_code == 204
    s = _summary(t["id"], a["id"])
    assert s["has_uncertified"] is True
    assert s["uncertified_days"] == [{"work_date": "2026-06-03", "working_as": "chair_umpire"}]
    by_date = {d["work_date"]: d["uncertified"] for d in s["days"]}
    assert by_date["2026-06-02"] is False
    assert by_date["2026-06-03"] is True


def test_removing_a_cert_after_assignment_flags_the_day():
    t = _tournament()
    o, certs = _official("chair_umpire")
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02", "chair_umpire")
    assert _summary(t["id"], a["id"])["has_uncertified"] is False
    # TD removes the cert later → the existing day is now uncertified
    assert client.delete(f"/api/certifications/{certs['chair_umpire']}").status_code == 204
    assert _summary(t["id"], a["id"])["has_uncertified"] is True


def test_report_totals_count_uncertified_officials():
    t = _tournament()
    o, certs = _official("chair_umpire")
    a = _assign(t["id"], o["id"])
    _add_day(a["id"], "2026-06-02", "chair_umpire")
    client.delete(f"/api/certifications/{certs['chair_umpire']}")   # now uncertified
    rep = client.get(f"/api/tournaments/{t['id']}/reports/officials").json()
    assert rep["totals"]["uncertified_count"] >= 1
