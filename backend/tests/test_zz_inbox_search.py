"""Server-side inbox filtering + pagination (q / limit / offset + X-Total-Count)."""
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


def _email(tid, subject, frm):
    return _ok(client.post("/api/emails", json={
        "tournament_id": tid, "subject": subject, "body": "b", "from_address": frm}))


def test_q_searches_subject_and_from_with_total_header():
    t = _tournament()
    tag = uuid.uuid4().hex[:8]
    _email(t["id"], f"Withdrawal {tag}", "alice@example.com")
    _email(t["id"], "Late entry", f"bob-{tag}@example.com")
    _email(t["id"], "Unrelated", "carol@example.com")

    # subject match
    r = client.get(f"/api/emails?tournament_id={t['id']}&q=Withdrawal {tag}")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1 and rows[0]["subject"] == f"Withdrawal {tag}"
    assert r.headers["x-total-count"] == "1"

    # from_address match
    rows = client.get(f"/api/emails?tournament_id={t['id']}&q=bob-{tag}").json()
    assert len(rows) == 1 and rows[0]["from_address"] == f"bob-{tag}@example.com"

    # no q → all three, total reflects it
    r = client.get(f"/api/emails?tournament_id={t['id']}")
    assert len(r.json()) == 3 and r.headers["x-total-count"] == "3"


def test_limit_offset_paginate_but_total_is_full_count():
    t = _tournament()
    for i in range(5):
        _email(t["id"], f"Msg {i}", "x@example.com")
    r = client.get(f"/api/emails?tournament_id={t['id']}&limit=2&offset=0")
    assert len(r.json()) == 2                       # page size
    assert r.headers["x-total-count"] == "5"         # full match count
    r2 = client.get(f"/api/emails?tournament_id={t['id']}&limit=2&offset=4")
    assert len(r2.json()) == 1                       # last partial page
