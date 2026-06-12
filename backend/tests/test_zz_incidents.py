"""Day-of incident log (P4-3, migration 0043): quick-log + resolve + scoping."""
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
        "name": "INC " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-11-01", "play_end_date": "2026-11-02"}))


def test_log_resolve_and_scope():
    t = _tournament()
    i = _ok(client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "weather", "severity": "minor",
        "description": "Rain delay courts 1-3"}))
    assert i["resolved"] is False and i["occurred_at"]      # defaulted to now
    # scoped list: this tournament sees it, another doesn't
    assert [x["id"] for x in _ok(client.get(f"/api/tournaments/{t['id']}/incidents"), 200)] == [i["id"]]
    t2 = _tournament()
    assert _ok(client.get(f"/api/tournaments/{t2['id']}/incidents"), 200) == []
    # resolve with a note
    r = _ok(client.put(f"/api/incidents/{i['id']}", json={
        "category": "weather", "severity": "minor",
        "description": "Rain delay courts 1-3",
        "resolved": True, "resolution": "Courts dried, resumed 14:30"}), 200)
    assert r["resolved"] is True and "14:30" in r["resolution"]
    # resolved incidents sort after open ones
    j = _ok(client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "facility", "description": "Net cord frayed court 2"}))
    rows = _ok(client.get(f"/api/tournaments/{t['id']}/incidents"), 200)
    assert [x["id"] for x in rows] == [j["id"], i["id"]]    # open first


def test_validation_and_404s():
    t = _tournament()
    assert client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "earthquake", "description": "x"}).status_code == 422
    assert client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "other", "description": ""}).status_code == 422
    assert client.post("/api/tournaments/99999999/incidents", json={
        "category": "other", "description": "x"}).status_code == 404
    assert client.put("/api/incidents/99999999", json={
        "category": "other", "description": "x", "resolved": False,
        "resolution": None}).status_code == 404
    assert client.delete("/api/incidents/99999999").status_code == 404


def test_site_label_and_delete():
    t = _tournament()
    site = _ok(client.post("/api/sites", json={
        "code": "IX" + uuid.uuid4().hex[:3], "name": "Inc Site " + uuid.uuid4().hex[:5]}))
    i = _ok(client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "injury", "severity": "major", "site_id": site["id"],
        "description": "Player ankle sprain court 4 — trainer on site"}))
    assert i["site_label"] == site["code"]
    assert client.delete(f"/api/incidents/{i['id']}").status_code == 204
    assert _ok(client.get(f"/api/tournaments/{t['id']}/incidents"), 200) == []
