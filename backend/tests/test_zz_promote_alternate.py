"""Promote an alternate to selected (roster slot opens when someone withdraws).

`POST /api/roster/{id}/promote` flips an *alternate* entry to selected; it
refuses to promote an already-selected or withdrawn entry.

Named to sort last (same rationale as the other test_zz modules)."""
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


def _entry(tid, status):
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    return _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": usta, "first_name": "P", "last_name": "L",
        "gender": "female", "age_division": "G14", "selection_status": status}))


def test_promote_alternate_to_selected():
    t = _tournament()
    e = _entry(t["id"], "alternate")
    out = _ok(client.post(f"/api/roster/{e['id']}/promote"), 200)
    assert out["selection_status"] == "selected"
    # the roster reflects it
    row = next(r for r in client.get(f"/api/tournaments/{t['id']}/players").json() if r["id"] == e["id"])
    assert row["selection_status"] == "selected"


def test_cannot_promote_a_selected_entry():
    t = _tournament()
    e = _entry(t["id"], "selected")
    r = client.post(f"/api/roster/{e['id']}/promote")
    assert r.status_code == 400
    assert "alternate" in r.json()["detail"].lower()


def test_cannot_promote_a_withdrawn_entry():
    t = _tournament()
    e = _entry(t["id"], "withdrawn")
    assert client.post(f"/api/roster/{e['id']}/promote").status_code == 400


def test_promote_unknown_entry_404():
    assert client.post("/api/roster/99999999/promote").status_code == 404
