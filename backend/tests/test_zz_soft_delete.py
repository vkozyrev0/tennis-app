"""Soft-delete (P2 #13): tournaments + incidents trash/restore, and that
trashed rows leave the lists but survive for restore."""
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
        "name": "SD " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-09-01", "play_end_date": "2026-09-02"}))


def _ids(rows):
    return {r["id"] for r in rows}


def test_tournament_soft_delete_hides_from_list_and_restores():
    t = _tournament()
    assert t["id"] in _ids(_ok(client.get("/api/tournaments"), 200))
    # soft-delete: 204, then gone from the active list
    assert client.delete(f"/api/tournaments/{t['id']}").status_code == 204
    assert t["id"] not in _ids(_ok(client.get("/api/tournaments"), 200))
    # but present in the trash
    trash = _ok(client.get("/api/trash"), 200)
    assert t["id"] in _ids(trash["tournaments"])
    # restore brings it back to the list and out of the trash
    restored = _ok(client.post(f"/api/tournaments/{t['id']}/restore"), 200)
    assert restored["id"] == t["id"]
    assert t["id"] in _ids(_ok(client.get("/api/tournaments"), 200))
    assert t["id"] not in _ids(_ok(client.get("/api/trash"), 200)["tournaments"])


def test_double_delete_404s_and_restore_requires_trashed():
    t = _tournament()
    assert client.delete(f"/api/tournaments/{t['id']}").status_code == 204
    # already trashed → no longer in the active set
    assert client.delete(f"/api/tournaments/{t['id']}").status_code == 404
    _ok(client.post(f"/api/tournaments/{t['id']}/restore"), 200)
    # restoring a non-trashed (now active) tournament 404s
    assert client.post(f"/api/tournaments/{t['id']}/restore").status_code == 404


def test_soft_deleted_tournament_preserves_its_children():
    # The point of soft-delete: a trashed tournament keeps its data for restore,
    # unlike a hard delete that would cascade it away.
    t = _tournament()
    p = _ok(client.post("/api/players", json={
        "usta_number": str(uuid.uuid4().int)[:10],
        "first_name": "Keep", "last_name": "Me", "gender": "female"}))
    e = _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected"}))
    assert client.delete(f"/api/tournaments/{t['id']}").status_code == 204
    _ok(client.post(f"/api/tournaments/{t['id']}/restore"), 200)
    roster = _ok(client.get(f"/api/tournaments/{t['id']}/players"), 200)
    assert e["id"] in _ids(roster)        # roster survived the trash round-trip


def test_incident_soft_delete_and_restore():
    t = _tournament()
    inc = _ok(client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "weather", "severity": "minor", "description": "rain delay"}))
    assert inc["id"] in _ids(_ok(client.get(f"/api/tournaments/{t['id']}/incidents"), 200))
    assert client.delete(f"/api/incidents/{inc['id']}").status_code == 204
    # gone from the tournament's incident list
    assert inc["id"] not in _ids(_ok(client.get(f"/api/tournaments/{t['id']}/incidents"), 200))
    # present in trash with its tournament name for context
    trash_inc = _ok(client.get("/api/trash"), 200)["incidents"]
    mine = next(i for i in trash_inc if i["id"] == inc["id"])
    assert mine["tournament_name"] == t["name"]
    # restore
    _ok(client.post(f"/api/incidents/{inc['id']}/restore"), 200)
    assert inc["id"] in _ids(_ok(client.get(f"/api/tournaments/{t['id']}/incidents"), 200))


def test_soft_deleted_tournament_leaves_dashboard_digest():
    # Locks the dashboard digest filter (deleted_at IS NULL) — easy to revert.
    t = _tournament()                              # play_end future → in digest
    digest = _ok(client.get("/api/dashboard/digest"), 200)["tournaments"]
    assert t["id"] in {d["tournament_id"] for d in digest}
    assert client.delete(f"/api/tournaments/{t['id']}").status_code == 204
    digest2 = _ok(client.get("/api/dashboard/digest"), 200)["tournaments"]
    assert t["id"] not in {d["tournament_id"] for d in digest2}


def test_soft_deleted_tournament_leaves_deadlines():
    # Locks the deadlines filter. within_days=120 so the ~Sep deadline is in range.
    t = _ok(client.post("/api/tournaments", json={
        "name": "DL " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-09-01", "play_end_date": "2026-09-03",
        "registration_deadline": "2026-09-01"}))
    dl = _ok(client.get("/api/dashboard/deadlines?within_days=120"), 200)["deadlines"]
    assert t["id"] in {d["tournament_id"] for d in dl}
    assert client.delete(f"/api/tournaments/{t['id']}").status_code == 204
    dl2 = _ok(client.get("/api/dashboard/deadlines?within_days=120"), 200)["deadlines"]
    assert t["id"] not in {d["tournament_id"] for d in dl2}


def test_incident_double_delete_404():
    t = _tournament()
    inc = _ok(client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "other", "severity": "info", "description": "x"}))
    assert client.delete(f"/api/incidents/{inc['id']}").status_code == 204
    assert client.delete(f"/api/incidents/{inc['id']}").status_code == 404
    assert client.post("/api/incidents/99999999/restore").status_code == 404
