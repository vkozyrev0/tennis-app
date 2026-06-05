"""Per-day coverage in the officials report (uncovered-day gaps).

For each day of the play window the report reports how many officials work it;
days with zero officials are surfaced (`uncovered_days`) so the TD fills them
before the event. Out-of-window worked days don't create phantom coverage.

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
    # 4-day window: 2026-06-01 .. 2026-06-04
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign(tid, oid, *work_dates):
    """One assignment per official (a tournament allows only one); add each day."""
    a = _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))
    for wd in work_dates:
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": wd, "working_as": "roving_official"}))
    return a


def _report(tid):
    return client.get(f"/api/tournaments/{tid}/reports/officials").json()


def test_coverage_lists_every_window_day_with_counts():
    t = _tournament()
    o1, o2 = _official(), _official()
    _assign(t["id"], o1["id"], "2026-06-02", "2026-06-03")   # o1 works 02 + 03
    _assign(t["id"], o2["id"], "2026-06-02")                 # o2 works 02 only

    rep = _report(t["id"])
    cov = {c["date"]: c["officials"] for c in rep["coverage"]}
    # every window day present
    assert set(cov) == {"2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"}
    assert cov["2026-06-01"] == 0
    assert cov["2026-06-02"] == 2
    assert cov["2026-06-03"] == 1
    assert cov["2026-06-04"] == 0
    assert rep["uncovered_days"] == ["2026-06-01", "2026-06-04"]
    assert rep["totals"]["uncovered_days_count"] == 2


def test_full_coverage_has_no_gaps():
    t = _tournament()
    o = _official()
    _assign(t["id"], o["id"], "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04")
    rep = _report(t["id"])
    assert rep["uncovered_days"] == []
    assert rep["totals"]["uncovered_days_count"] == 0
    assert all(c["officials"] == 1 for c in rep["coverage"])


def test_out_of_window_day_does_not_create_phantom_coverage():
    t = _tournament()
    o = _official()
    # assign a day OUTSIDE the window — it must not appear in coverage, and every
    # in-window day stays uncovered.
    _assign(t["id"], o["id"], "2026-06-10")
    rep = _report(t["id"])
    dates = {c["date"] for c in rep["coverage"]}
    assert "2026-06-10" not in dates
    assert rep["totals"]["uncovered_days_count"] == 4   # all 4 window days empty
