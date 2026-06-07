"""Inbox aging — oldest unfiled emails first (GET /api/emails/aging).

Days-waiting per unfiled email, oldest first, optionally per tournament.
Named to sort last."""
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


def _email(tid, subject):
    return _ok(client.post("/api/emails", json={
        "tournament_id": tid, "from_address": "p@example.com",
        "subject": subject, "body": "b"}))


def _aging(tid, limit=10):
    return _ok(client.get(f"/api/emails/aging?tournament_id={tid}&limit={limit}"), 200)


def test_unfiled_listed_with_age():
    t = _tournament()
    e = _email(t["id"], "Old one")
    out = _aging(t["id"])
    assert out["count"] == 1
    row = out["items"][0]
    assert row["id"] == e["id"]
    assert row["subject"] == "Old one"
    assert row["age_days"] >= 0
    assert out["oldest_age_days"] == row["age_days"]


def test_filed_email_excluded():
    t = _tournament()
    e = _email(t["id"], "Will file")
    _ok(client.put(f"/api/emails/{e['id']}", json={"status": "filed"}), 200)
    assert _aging(t["id"])["count"] == 0


def test_scoped_to_tournament():
    t1, t2 = _tournament(), _tournament()
    _email(t1["id"], "t1 mail")
    out = _aging(t2["id"])
    assert out["count"] == 0


def test_limit_capped_and_oldest_first():
    t = _tournament()
    for i in range(3):
        _email(t["id"], f"mail {i}")
    out = _aging(t["id"], limit=2)
    assert out["count"] == 2  # capped to limit
    # oldest-first: ages are non-increasing down the list
    ages = [r["age_days"] for r in out["items"]]
    assert ages == sorted(ages, reverse=True)
