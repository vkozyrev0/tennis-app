"""Auto-distance prototype (Phase 2 / D3): great-circle mileage estimate.

Covers the key-free fallback — haversine math + the POST /api/distances/auto
endpoint that estimates official↔site one-way miles from stored coordinates and
upserts a `geocoded` distance. (A real routing API is still the authoritative
source; this is the seam + fallback.)
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.geocode import estimate_one_way_miles, haversine_miles
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


def test_haversine_and_estimate_math():
    assert haversine_miles(0, 0, 0, 0) == 0
    # ~1° of latitude ≈ 69 statute miles
    d = haversine_miles(40.0, -75.0, 41.0, -75.0)
    assert 68 < d < 70
    # estimate applies the road-circuity factor and rounds to 0.1
    assert estimate_one_way_miles(40.0, -75.0, 41.0, -75.0) == round(d * 1.2, 1)


def _official(lat=None, lng=None):
    body = {"first_name": "Geo", "last_name": "Ref " + uuid.uuid4().hex[:5]}
    if lat is not None:
        body["lat"], body["lng"] = lat, lng
    return _ok(client.post("/api/officials", json=body))


def _site(lat=None, lng=None):
    body = {"name": "Court " + uuid.uuid4().hex[:5]}
    if lat is not None:
        body["lat"], body["lng"] = lat, lng
    return _ok(client.post("/api/sites", json=body))


def test_auto_distance_from_coordinates_upserts_geocoded():
    o = _official(40.0, -75.0)
    s = _site(40.5, -75.0)
    res = _ok(client.post("/api/distances/auto",
                          json={"official_id": o["id"], "site_id": s["id"]}), 201)
    assert res["source"] == "geocoded"
    assert res["one_way_miles"] == estimate_one_way_miles(40.0, -75.0, 40.5, -75.0)
    # re-running upserts (no 409 even though the pair already exists)
    res2 = _ok(client.post("/api/distances/auto",
                           json={"official_id": o["id"], "site_id": s["id"]}), 201)
    assert res2["id"] == res["id"]
    assert res2["one_way_miles"] == res["one_way_miles"]


def test_auto_distance_missing_coordinates_returns_422():
    o = _official()                  # no coords
    s = _site(40.5, -75.0)
    r = client.post("/api/distances/auto", json={"official_id": o["id"], "site_id": s["id"]})
    assert r.status_code == 422
    assert "coordinates" in r.json()["detail"]


def test_auto_distance_unknown_ids_404():
    s = _site(40.5, -75.0)
    assert client.post("/api/distances/auto",
                       json={"official_id": 10_000_000, "site_id": s["id"]}).status_code == 404
