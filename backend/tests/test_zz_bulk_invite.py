"""Bulk official invites — assign several officials to a tournament at once.

`POST /api/tournaments/{id}/assignments/bulk` creates one pending assignment
per official, skipping any already assigned (idempotent re-run) and reporting
invalid ids. Returns the contact emails of the new invites for a single mailto.

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


def _official(email=None):
    body = {"first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}
    if email:
        body["email"] = email
    return _ok(client.post("/api/officials", json=body))


def _bulk(tid, ids, **extra):
    return client.post(f"/api/tournaments/{tid}/assignments/bulk",
                       json={"official_ids": ids, **extra})


def test_bulk_creates_pending_for_each():
    t = _tournament()
    a = _official(email=f"a_{uuid.uuid4().hex[:6]}@ex.com")
    b = _official()  # no email
    out = _ok(_bulk(t["id"], [a["id"], b["id"]]))
    assert out["created_count"] == 2
    assert {c["official_id"] for c in out["created"]} == {a["id"], b["id"]}
    assert all(c["response_status"] == "pending" for c in out["created"])
    # only the official with an email on file shows up in the mailto list
    assert len(out["invite_emails"]) == 1
    # and the assignments are really there
    got = client.get(f"/api/tournaments/{t['id']}/assignments").json()
    assert {g["official_id"] for g in got} == {a["id"], b["id"]}


def test_bulk_skips_already_assigned():
    t = _tournament()
    a = _official()
    _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": a["id"]}))
    b = _official()
    out = _ok(_bulk(t["id"], [a["id"], b["id"]]))
    assert out["created_count"] == 1
    assert out["created"][0]["official_id"] == b["id"]
    assert out["skipped_existing"] == [a["id"]]


def test_bulk_reports_invalid_ids():
    t = _tournament()
    a = _official()
    out = _ok(_bulk(t["id"], [a["id"], 99999999]))
    assert out["created_count"] == 1
    assert out["invalid"] == [99999999]


def test_bulk_dedupes_input():
    t = _tournament()
    a = _official()
    out = _ok(_bulk(t["id"], [a["id"], a["id"]]))
    assert out["created_count"] == 1


def test_bulk_empty_list_400():
    t = _tournament()
    assert _bulk(t["id"], []).status_code == 400


def test_bulk_unknown_tournament_404():
    a = _official()
    assert _bulk(99999999, [a["id"]]).status_code == 404
