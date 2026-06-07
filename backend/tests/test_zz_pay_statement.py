"""Per-official reimbursement pay statement (GET .../pay-statement).

Day-level breakdown: each assignment's worked days (role + rate), mileage calc,
and a grand total — the detail behind the printable reimbursement statement.

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


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Pay", "last_name": "Ee " + uuid.uuid4().hex[:5],
        "email": "pay@example.com", "city": "Austin", "state": "TX"}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _statement(oid):
    return _ok(client.get(f"/api/officials/{oid}/pay-statement"), 200)


def test_statement_has_day_detail_and_totals():
    t = _tournament()
    o = _official()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    for d in ("2026-06-01", "2026-06-02"):
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": d, "working_as": "roving_official"}))
    st = _statement(o["id"])
    assert st["official"]["name"].startswith("Ee")
    assert st["official"]["location"] == "Austin, TX"
    assert len(st["assignments"]) == 1
    asg = st["assignments"][0]
    assert [d["work_date"] for d in asg["days"]] == ["2026-06-01", "2026-06-02"]
    assert all(d["rate_applied"] > 0 for d in asg["days"])
    assert st["totals"]["days"] == 2
    assert st["totals"]["pay"] == asg["pay"]


def test_statement_empty_for_unassigned_official():
    o = _official()
    st = _statement(o["id"])
    assert st["assignments"] == []
    assert st["totals"] == {"pay": 0, "mileage": 0, "total": 0, "days": 0, "assignments": 0}


def test_statement_404_for_unknown_official():
    assert client.get("/api/officials/99999999/pay-statement").status_code == 404
