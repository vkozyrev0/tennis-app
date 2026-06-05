"""Inbox status-counts (filed vs unfiled progress).

`GET /api/emails/status-counts?tournament_id=` reports how many emails are new
(unfiled) / filed / need follow-up, so the inbox can show what's left to process.

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


def _email(tid, subject="hi", status=None):
    e = _ok(client.post("/api/emails", json={
        "tournament_id": tid, "subject": subject, "body": "b", "from_address": "x@y.com"}))
    if status:
        # PUT is a full replace — keep tournament_id so the row stays scoped.
        _ok(client.put(f"/api/emails/{e['id']}",
                       json={"tournament_id": tid, "classification": "withdrawal", "status": status}), 200)
    return e


def _counts(tid):
    return client.get(f"/api/emails/status-counts?tournament_id={tid}").json()


def test_counts_partition_by_status():
    t = _tournament()
    _email(t["id"])                       # new
    _email(t["id"])                       # new
    _email(t["id"], status="filed")       # filed
    _email(t["id"], status="needs_followup")
    c = _counts(t["id"])
    assert c["new"] == 2
    assert c["filed"] == 1
    assert c["needs_followup"] == 1
    assert c["total"] == 4


def test_counts_empty_tournament_is_all_zero():
    t = _tournament()
    c = _counts(t["id"])
    assert c == {"new": 0, "filed": 0, "needs_followup": 0, "total": 0}


def test_counts_scoped_to_tournament():
    t1, t2 = _tournament(), _tournament()
    _email(t1["id"]); _email(t1["id"])
    _email(t2["id"])
    assert _counts(t1["id"])["new"] == 2
    assert _counts(t2["id"])["new"] == 1
