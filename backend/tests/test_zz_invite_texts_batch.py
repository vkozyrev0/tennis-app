"""Tournament-level invite-all (GET .../invite-texts).

A personalised invite for every assigned official, plus the list of emails on
file (for a BCC-all). Named to sort last."""
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
        "name": "InvAll " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _official(email=None):
    body = {"first_name": "Inv", "last_name": "O " + uuid.uuid4().hex[:5]}
    if email:
        body["email"] = email
    o = _ok(client.post("/api/officials", json=body))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign(tid, oid):
    return _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))


def _batch(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/invite-texts"), 200)


def test_invite_all_one_per_assignment():
    t = _tournament()
    o1 = _official(email="one@example.com")
    o2 = _official()  # no email
    _assign(t["id"], o1["id"])
    _assign(t["id"], o2["id"])
    b = _batch(t["id"])
    assert b["count"] == 2
    assert all(i["subject"] and i["body"].startswith("Dear ") for i in b["invites"])
    # only officials with an email show up in the BCC list
    assert b["emails"] == ["one@example.com"]


def test_invite_all_empty_tournament():
    t = _tournament()
    b = _batch(t["id"])
    assert b == {"invites": [], "count": 0, "emails": []}


def test_invite_all_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/invite-texts").status_code == 404
