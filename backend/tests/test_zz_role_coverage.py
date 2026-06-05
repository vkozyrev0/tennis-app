"""Per-role, per-day coverage in the officials report.

`role_coverage` reports officials working each role (cert type) per day across
the play window, so the TD spots a day thin on a needed role — not just total
headcount. Rows are the roles actually used in the tournament's assignments.

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
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-03"}))


def _official(*certs):
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    for c in certs:
        _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": c}))
    return o


def _assign(tid, oid, role, *days):
    a = _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))
    for d in days:
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": d, "working_as": role}))
    return a


def _report(tid):
    return client.get(f"/api/tournaments/{tid}/reports/officials").json()


def _role(report, role):
    return next(r for r in report["role_coverage"] if r["role"] == role)


def test_role_coverage_counts_per_role_per_day():
    t = _tournament()
    chair1, chair2 = _official("chair_umpire"), _official("chair_umpire")
    rover = _official("roving_official")
    _assign(t["id"], chair1["id"], "chair_umpire", "2026-06-01", "2026-06-02")
    _assign(t["id"], chair2["id"], "chair_umpire", "2026-06-01")          # chairs: 06-01=2, 06-02=1
    _assign(t["id"], rover["id"], "roving_official", "2026-06-02")        # rover: 06-02=1

    rep = _report(t["id"])
    chair = {b["date"]: b["officials"] for b in _role(rep, "chair_umpire")["by_date"]}
    rov = {b["date"]: b["officials"] for b in _role(rep, "roving_official")["by_date"]}
    assert chair["2026-06-01"] == 2 and chair["2026-06-02"] == 1 and chair["2026-06-03"] == 0
    assert rov["2026-06-01"] == 0 and rov["2026-06-02"] == 1
    # only the two used roles appear
    assert {r["role"] for r in rep["role_coverage"]} == {"chair_umpire", "roving_official"}


def test_role_coverage_spans_every_window_day():
    t = _tournament()
    o = _official("roving_official")
    _assign(t["id"], o["id"], "roving_official", "2026-06-02")
    dates = [b["date"] for b in _role(_report(t["id"]), "roving_official")["by_date"]]
    assert dates == ["2026-06-01", "2026-06-02", "2026-06-03"]   # all window days, in order


def test_role_coverage_empty_when_no_assignments():
    t = _tournament()
    assert _report(t["id"])["role_coverage"] == []


def test_official_days_total_sums_all_worked_days():
    t = _tournament()
    o1 = _official("roving_official")
    o2 = _official("roving_official")
    _assign(t["id"], o1["id"], "roving_official", "2026-06-01", "2026-06-02", "2026-06-03")
    _assign(t["id"], o2["id"], "roving_official", "2026-06-02")
    rep = _report(t["id"])
    assert rep["totals"]["official_days_total"] == 4   # 3 + 1
    # per-official day counts are on the official objects (the Days column source)
    by = {o["official_name"]: len(o["days"]) for o in rep["officials"]}
    assert sorted(by.values()) == [1, 3]
