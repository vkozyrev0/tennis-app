"""Tournament-level batch pay statements (GET .../pay-statements).

One statement per official assigned to the tournament (worked days + rate,
mileage, total) plus a tournament grand total. Named to sort last."""
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
        "name": "Batch " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "B", "last_name": "Off " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign_with_day(tid, oid, day):
    a = _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": day, "working_as": "roving_official"}))
    return a


def _batch(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/pay-statements"), 200)


def test_batch_lists_each_official_with_totals():
    t = _tournament()
    o1, o2 = _official(), _official()
    _assign_with_day(t["id"], o1["id"], "2026-06-01")
    _assign_with_day(t["id"], o2["id"], "2026-06-02")
    b = _batch(t["id"])
    assert b["totals"]["officials"] == 2
    assert b["totals"]["days"] == 2
    assert b["totals"]["pay"] == round(sum(o["pay"] for o in b["officials"]), 2)
    assert all(len(o["days"]) == 1 for o in b["officials"])


def test_batch_empty_tournament():
    t = _tournament()
    b = _batch(t["id"])
    assert b["officials"] == []
    assert b["totals"]["officials"] == 0
    assert b["tournament"]["id"] == t["id"]


def test_batch_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/pay-statements").status_code == 404
