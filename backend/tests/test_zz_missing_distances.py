"""Missing-distance report (GET .../missing-distances).

Official↔site assignment pairs lacking a mileage distance (mileage can't compute).
Named to sort last."""
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


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Dist", "last_name": "Ee " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign(tid, oid, site_id):
    return _ok(client.post(f"/api/tournaments/{tid}/assignments",
                           json={"official_id": oid, "site_id": site_id}))


def _missing(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/missing-distances"), 200)


def test_missing_pair_listed_then_clears_after_adding_distance():
    t = _tournament()
    s = _site()
    o = _official()
    _assign(t["id"], o["id"], s["id"])
    out = _missing(t["id"])
    assert out["count"] == 1
    row = out["items"][0]
    assert row["official_id"] == o["id"] and row["site_id"] == s["id"]
    # add the distance → the pair clears
    _ok(client.post("/api/distances", json={
        "official_id": o["id"], "site_id": s["id"], "one_way_miles": 20, "source": "manual"}))
    assert _missing(t["id"])["count"] == 0


def test_assignment_without_site_not_listed():
    t = _tournament()
    o = _official()
    # no site_id → mileage doesn't apply → not a missing-distance row
    _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    assert _missing(t["id"])["count"] == 0


def test_missing_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/missing-distances").status_code == 404
