"""Dietary summary for catering (GET .../dietary-summary).

Assigned officials grouped by dietary restriction (case-insensitive), counts +
names, plus a none-count. Declined officials excluded. Named to sort last."""
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


def _official(diet=None):
    body = {"first_name": "Diet", "last_name": "Ee " + uuid.uuid4().hex[:5]}
    if diet:
        body["dietary_restrictions"] = diet
    o = _ok(client.post("/api/officials", json=body))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign(tid, oid):
    return _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))


def _summary(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/dietary-summary"), 200)


def test_groups_case_insensitively_with_counts():
    t = _tournament()
    _assign(t["id"], _official("Vegetarian")["id"])
    _assign(t["id"], _official("vegetarian")["id"])  # same, different case
    _assign(t["id"], _official("Gluten-free")["id"])
    _assign(t["id"], _official()["id"])              # no restriction
    s = _summary(t["id"])
    assert s["total_people"] == 4
    assert s["none_count"] == 1
    assert s["with_restrictions"] == 3
    veg = next(i for i in s["items"] if i["restriction"].lower() == "vegetarian")
    assert veg["count"] == 2
    assert len(veg["people"]) == 2
    # sorted most-common first
    assert s["items"][0]["count"] == 2


def test_empty_tournament():
    t = _tournament()
    s = _summary(t["id"])
    assert s["items"] == []
    assert s["total_people"] == 0
    assert s["none_count"] == 0


def test_dietary_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/dietary-summary").status_code == 404
