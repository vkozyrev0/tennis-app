"""Unmatched-player drilldown: the count + server-side filter for inbox emails
the detector couldn't match to a roster player.

`GET /api/emails/status-counts` now returns `unmatched` (still-new emails on a
tournament with no detected player). `GET /api/emails?unmatched=true` filters to
exactly those rows (server-side, so it's accurate across pages).

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


def _email(tid, subject="Hi", bodytext="hello"):
    return _ok(client.post("/api/emails", json={
        "tournament_id": tid, "from_address": "p@example.com",
        "subject": subject, "body": bodytext}))


def _counts(tid):
    return _ok(client.get(f"/api/emails/status-counts?tournament_id={tid}"), 200)


def test_unmatched_count_in_status_counts():
    t = _tournament()
    _email(t["id"])  # no rostered player → unmatched
    _email(t["id"])
    c = _counts(t["id"])
    assert c["unmatched"] == 2
    assert c["new"] == 2


def test_matched_email_not_counted_unmatched():
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "usta_number": usta, "first_name": "Match", "last_name": "Me",
        "gender": "female", "age_division": "G16", "selection_status": "selected"}))
    e = _email(t["id"], "Withdrawal", f"USTA {usta} withdrawing")
    # detect the player → now matched
    _ok(client.post(f"/api/emails/{e['id']}/detect-player"), 200)
    assert _counts(t["id"])["unmatched"] == 0


def test_unmatched_filter_returns_only_unmatched():
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "usta_number": usta, "first_name": "Seen", "last_name": "Player",
        "gender": "female", "age_division": "G16", "selection_status": "selected"}))
    matched = _email(t["id"], "Withdrawal", f"USTA {usta} withdrawing")
    _ok(client.post(f"/api/emails/{matched['id']}/detect-player"), 200)
    unmatched = _email(t["id"], "Question", "no id here")
    rows = client.get(f"/api/emails?tournament_id={t['id']}&unmatched=true").json()
    ids = {r["id"] for r in rows}
    assert unmatched["id"] in ids
    assert matched["id"] not in ids


def test_filed_email_not_counted_unmatched():
    # status-counts unmatched is scoped to NEW emails — a filed one doesn't count
    t = _tournament()
    e = _email(t["id"])
    _ok(client.put(f"/api/emails/{e['id']}", json={"status": "filed"}), 200)
    assert _counts(t["id"])["unmatched"] == 0
