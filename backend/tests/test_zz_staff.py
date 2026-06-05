"""Non-official tournament staff: CRUD + report integration (migration 0032)."""
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


def test_staff_crud_roundtrip():
    t = _tournament()
    s = _ok(client.post(f"/api/tournaments/{t['id']}/staff", json={
        "name": "Pat Stringer", "role": "stringer", "phone": "555-1212"}))
    assert s["tournament_id"] == t["id"] and s["role"] == "stringer"
    # list
    rows = client.get(f"/api/tournaments/{t['id']}/staff").json()
    assert any(r["id"] == s["id"] for r in rows)
    # update
    up = _ok(client.put(f"/api/staff/{s['id']}", json={
        "name": "Pat Stringer", "role": "operations", "notes": "moved roles"}), 200)
    assert up["role"] == "operations" and up["notes"] == "moved roles"
    # delete
    assert client.delete(f"/api/staff/{s['id']}").status_code == 204
    assert all(r["id"] != s["id"] for r in client.get(f"/api/tournaments/{t['id']}/staff").json())


def test_staff_rejects_unknown_role():
    t = _tournament()
    r = client.post(f"/api/tournaments/{t['id']}/staff",
                    json={"name": "X", "role": "ballkid"})
    assert r.status_code == 422


def test_staff_create_on_missing_tournament_404():
    r = client.post("/api/tournaments/10000000/staff",
                    json={"name": "X", "role": "trainer"})
    assert r.status_code == 404


def test_report_includes_staff_grouped():
    t = _tournament()
    _ok(client.post(f"/api/tournaments/{t['id']}/staff",
                    json={"name": "Dana Director", "role": "site_director"}))
    _ok(client.post(f"/api/tournaments/{t['id']}/staff",
                    json={"name": "Tia Trainer", "role": "trainer"}))
    rep = client.get(f"/api/tournaments/{t['id']}/reports/officials").json()
    assert rep["totals"]["staff_count"] == 2
    roles = {s["role"] for s in rep["staff"]}
    assert roles == {"site_director", "trainer"}


def test_staff_cascades_on_tournament_delete():
    t = _tournament()
    s = _ok(client.post(f"/api/tournaments/{t['id']}/staff",
                        json={"name": "Gone", "role": "other"}))
    assert client.delete(f"/api/tournaments/{t['id']}").status_code == 204
    # the staff row is gone with the tournament (FK ON DELETE CASCADE)
    assert client.put(f"/api/staff/{s['id']}", json={
        "name": "Gone", "role": "other"}).status_code == 404
