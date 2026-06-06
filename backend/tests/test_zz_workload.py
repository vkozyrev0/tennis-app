"""Official workload balance (GET /api/officials/workload).

Cross-tournament days/assignments per official (busiest first), every official
included so zero-load ones surface. Named to sort last."""
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
        "first_name": "Wk", "last_name": "Ld " + uuid.uuid4().hex[:6]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign_days(tid, oid, days):
    a = _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))
    for d in days:
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": d, "working_as": "roving_official"}))
    return a


def _row(oid):
    w = _ok(client.get("/api/officials/workload"), 200)
    return w, next((o for o in w["officials"] if o["official_id"] == oid), None)


def test_workload_counts_days_and_assignments():
    t = _tournament()
    busy = _official()
    _assign_days(t["id"], busy["id"], ["2026-06-01", "2026-06-02", "2026-06-03"])
    _w, row = _row(busy["id"])
    assert row["assignments"] == 1
    assert row["days"] == 3
    assert row["tournaments"] == 1
    assert row["pending"] == 1  # not yet responded


def test_zero_load_official_is_listed():
    o = _official()  # never assigned
    _w, row = _row(o["id"])
    assert row is not None
    assert row["assignments"] == 0 and row["days"] == 0


def test_busiest_first_ordering():
    t = _tournament()
    light = _official()
    heavy = _official()
    _assign_days(t["id"], light["id"], ["2026-06-01"])
    _assign_days(t["id"], heavy["id"], ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"])
    w, _ = _row(heavy["id"])
    order = [o["official_id"] for o in w["officials"]]
    assert order.index(heavy["id"]) < order.index(light["id"])


def test_workload_route_not_swallowed_by_dynamic_id():
    # "/workload" must resolve to the list endpoint (200 dict), not be parsed as
    # an official id (which would 422). Guards the route-ordering fix.
    r = client.get("/api/officials/workload")
    assert r.status_code == 200
    assert "officials" in r.json()
