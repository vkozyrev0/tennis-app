"""One-click triage chain (POST /api/emails/bulk/triage).

Runs classify → detect-players → populate over the selected emails in one
request and returns a combined summary. Verifies the end-to-end happy path
(an unclassified withdrawal email for a rostered player gets classified,
matched, and filed as a withdrawal row).

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


def _rostered_player(tid):
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    first, last = "Tri", "Age" + uuid.uuid4().hex[:5]
    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": usta, "first_name": first, "last_name": last,
        "gender": "female", "age_division": "G16", "selection_status": "selected"}))
    return usta, first, last


def _email(tid, subject, bodytext):
    return _ok(client.post("/api/emails", json={
        "tournament_id": tid, "from_address": "p@example.com",
        "subject": subject, "body": bodytext}))


def test_triage_classifies_detects_and_files():
    t = _tournament()
    usta, first, last = _rostered_player(t["id"])
    e = _email(t["id"], "Withdrawal",
               f"Player {first} {last} (USTA {usta}) is withdrawing due to injury.")
    res = _ok(client.post("/api/emails/bulk/triage",
                          json={"email_ids": [e["id"]]}), 200)
    assert res["classified"] == 1
    assert res["classify_counts"].get("withdrawal") == 1
    assert res["detected"] == 1
    assert res["filed"] == 1
    # the withdrawal row really exists for this tournament
    wds = client.get(f"/api/tournaments/{t['id']}/withdrawals").json()
    assert any(w["usta_number"] == usta for w in wds)
    # and the email is now filed
    em = next(x for x in client.get(f"/api/emails?tournament_id={t['id']}").json()
              if x["id"] == e["id"])
    assert em["status"] == "filed"


def test_triage_reports_skips_for_unmatched():
    t = _tournament()
    # withdrawal email but NO rostered player → classifies, can't detect, skipped
    e = _email(t["id"], "Withdrawal", "I am withdrawing, no id given")
    res = _ok(client.post("/api/emails/bulk/triage", json={"email_ids": [e["id"]]}), 200)
    assert res["classified"] == 1
    assert res["filed"] == 0
    assert any(s["id"] == e["id"] for s in res["skipped"])


def test_triage_empty_noop():
    res = _ok(client.post("/api/emails/bulk/triage", json={"email_ids": []}), 200)
    assert res == {"classified": 0, "detected": 0, "filed": 0,
                   "classify_counts": {}, "skipped": []}
