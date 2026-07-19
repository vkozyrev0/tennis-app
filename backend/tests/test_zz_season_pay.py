"""Per-official season pay summary (across all tournaments) — TD + self-service."""
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


def _assign_day(oid, site_id):
    t = _tournament()
    _ok(client.put(f"/api/tournaments/{t['id']}/sites",
                   json={"site_ids": [site_id]}), 200)
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": oid, "site_id": site_id}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-02", "working_as": "roving_official"}))
    return t


def test_season_pay_aggregates_across_tournaments():
    site = _ok(client.post("/api/sites", json={"name": "S " + uuid.uuid4().hex[:6]}))
    o = _ok(client.post("/api/officials", json={"first_name": "Sea", "last_name": "Son " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    _ok(client.post("/api/distances", json={
        "official_id": o["id"], "site_id": site["id"], "one_way_miles": 100, "source": "manual"}))
    _assign_day(o["id"], site["id"])
    _assign_day(o["id"], site["id"])

    s = client.get(f"/api/officials/{o['id']}/pay-summary").json()
    assert s["totals"]["assignments"] == 2
    assert s["totals"]["days"] == 2
    # roving $150/day × 2 days = $300; mileage clamp((2*100-50)*0.65)=97.5 × 2 = 195
    assert s["totals"]["pay"] == 300.0
    assert s["totals"]["mileage"] == 195.0
    assert s["totals"]["total"] == 495.0
    assert len(s["tournaments"]) == 2
    assert all("tournament_name" in t for t in s["tournaments"])


def test_self_service_pay_summary_matches_td():
    site = _ok(client.post("/api/sites", json={"name": "S " + uuid.uuid4().hex[:6]}))
    o = _ok(client.post("/api/officials", json={"first_name": "Me", "last_name": "Pay " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    uname = "spay_" + uuid.uuid4().hex[:8]
    _ok(client.put(f"/api/officials/{o['id']}/account", json={"username": uname, "password": "pw"}), 200)
    _assign_day(o["id"], site["id"])

    td = client.get(f"/api/officials/{o['id']}/pay-summary").json()
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": "pw"}), 200)
    mine = sess.get("/api/me/pay-summary").json()
    assert mine["totals"] == td["totals"] and mine["official_id"] == o["id"]


def test_unknown_official_404():
    assert client.get("/api/officials/10000000/pay-summary").status_code == 404
