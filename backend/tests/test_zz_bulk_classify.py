"""Bulk auto-classify inbox emails (POST /api/emails/bulk/classify).

Runs the local rule-based triage classifier over selected emails and writes each
one's suggested classification, so the TD can bulk-classify → detect-players →
populate to clear the unfiled queue. By default only 'unclassified' emails are
touched (a manual classification is never clobbered).

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


def _email(tid, subject, bodytext):
    return _ok(client.post("/api/emails", json={
        "tournament_id": tid, "from_address": "p@example.com",
        "subject": subject, "body": bodytext}))


def _classify(ids, **extra):
    return _ok(client.post("/api/emails/bulk/classify",
                           json={"email_ids": ids, **extra}), 200)


def test_bulk_classify_sets_suggestion():
    t = _tournament()
    wd = _email(t["id"], "Withdrawal", "I am withdrawing from the event")
    le = _email(t["id"], "Question", "I missed the deadline, can I still enter?")
    out = _classify([wd["id"], le["id"]])
    assert out["classified"] == 2
    by = {c["id"]: c["classification"] for c in out["changed"]}
    assert by[wd["id"]] == "withdrawal"
    assert by[le["id"]] == "late_entry"
    assert out["counts"].get("withdrawal") == 1


def test_only_unclassified_by_default():
    t = _tournament()
    e = _email(t["id"], "Withdrawal", "withdrawing")
    # set a manual classification first
    _ok(client.put(f"/api/emails/{e['id']}", json={"classification": "doubles"}), 200)
    out = _classify([e["id"]])  # default only_unclassified=True
    assert out["classified"] == 0  # manual 'doubles' not clobbered


def test_force_reclassify_overwrites():
    t = _tournament()
    e = _email(t["id"], "Withdrawal", "withdrawing")
    _ok(client.put(f"/api/emails/{e['id']}", json={"classification": "other"}), 200)
    out = _classify([e["id"]], only_unclassified=False)
    assert out["classified"] == 1
    assert out["changed"][0]["classification"] == "withdrawal"


def test_empty_list_noop():
    out = _classify([])
    assert out["classified"] == 0
