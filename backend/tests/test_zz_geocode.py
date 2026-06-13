"""Auto-distance prototype (Phase 2 / D3): great-circle mileage estimate.

Covers the key-free fallback — haversine math + the POST /api/distances/auto
endpoint that estimates official↔site one-way miles from stored coordinates and
upserts a `geocoded` distance. (A real routing API is still the authoritative
source; this is the seam + fallback.)
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app import geocode
from app.geocode import estimate_one_way_miles, haversine_miles, road_one_way_miles
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


def test_road_one_way_falls_back_to_estimate_without_key(monkeypatch):
    # No GOOGLE_MAPS_API_KEY → great-circle estimate, source 'geocoded'.
    monkeypatch.setattr(geocode, "maps_api_key", lambda: None)
    miles, source = road_one_way_miles(40.0, -75.0, 40.5, -75.0)
    assert source == "geocoded"
    assert miles == estimate_one_way_miles(40.0, -75.0, 40.5, -75.0)


def test_road_one_way_uses_maps_when_key_set(monkeypatch):
    # Key present + a (mocked) Distance Matrix result → source 'maps', its miles.
    monkeypatch.setattr(geocode, "maps_api_key", lambda: "fake-key")
    monkeypatch.setattr(geocode, "_maps_driving_miles", lambda *a, **k: 42.37)
    miles, source = road_one_way_miles(40.0, -75.0, 40.5, -75.0)
    assert source == "maps" and miles == 42.4          # rounded to 0.1


def test_road_one_way_degrades_to_estimate_when_api_errors(monkeypatch):
    # A flaky/failed API must never block mileage — fall back, don't raise.
    monkeypatch.setattr(geocode, "maps_api_key", lambda: "fake-key")
    def boom(*a, **k):
        raise RuntimeError("quota exceeded")
    monkeypatch.setattr(geocode, "_maps_driving_miles", boom)
    miles, source = road_one_way_miles(40.0, -75.0, 40.5, -75.0)
    assert source == "geocoded"
    assert miles == estimate_one_way_miles(40.0, -75.0, 40.5, -75.0)


def test_auto_distance_stamps_maps_source_with_key(monkeypatch):
    # End-to-end: the /auto endpoint stores source 'maps' (exercises the 0047
    # enum value) when the key path resolves a driving distance.
    monkeypatch.setattr(geocode, "maps_api_key", lambda: "fake-key")
    monkeypatch.setattr(geocode, "_maps_driving_miles", lambda *a, **k: 12.0)
    o = _official(40.0, -75.0)
    s = _site(40.5, -75.0)
    res = _ok(client.post("/api/distances/auto",
                          json={"official_id": o["id"], "site_id": s["id"]}), 201)
    assert res["source"] == "maps" and res["one_way_miles"] == 12.0


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
