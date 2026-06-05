"""PII hardening H3 (retention/erasure) — docs/pii-hardening-plan.md §H3.

- deleting a player erases their PII from the FK-less player_history audit table
  (rows kept, PII columns nulled)
- the email-body retention purge redacts FILED emails' free text, leaving
  unprocessed ('new') mail untouched

Named to sort last (shared courtops_test DB; the purge touches filed emails
DB-wide, so it must run after the inbox tests that assert on bodies).
"""
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


def test_delete_player_erases_pii_from_history():
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    p = _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": "Aaa", "last_name": "Bbb", "gender": "male"}))
    # a name change writes an 'update' history row carrying the OLD PII
    _ok(client.put(f"/api/players/{p['id']}", json={
        "usta_number": usta, "first_name": "Ccc", "last_name": "Bbb", "gender": "male"}),
        code=200)
    hist_before = client.get(f"/api/players/{p['id']}/history").json()
    assert any(h["first_name"] == "Aaa" for h in hist_before)  # PII present pre-delete

    assert client.delete(f"/api/players/{p['id']}").status_code == 204

    hist = client.get(f"/api/players/{p['id']}/history").json()
    assert hist, "audit rows should survive the delete"
    for h in hist:                                              # ...but with PII erased
        assert h["first_name"] is None
        assert h["last_name"] is None
        assert h["usta_number"] is None
        assert h["birthdate"] is None


def test_purge_redacts_filed_emails_but_not_new_ones():
    t = _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))

    def _email(subject, body):
        return _ok(client.post("/api/emails", json={
            "tournament_id": t["id"], "subject": subject, "body": body,
            "from_address": "parent@example.com"}))

    filed = _email("Filed one", "sensitive minor details here")
    client.put(f"/api/emails/{filed['id']}", json={
        "tournament_id": t["id"], "classification": "late_entry",
        "status": "filed", "detected_player_id": None})
    fresh = _email("New one", "still under review")

    res = _ok(client.post("/api/emails/purge?older_than_days=0"), 200)
    assert res["purged"] >= 1

    rows = {m["id"]: m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()}
    # filed email: free-text PII redacted, provenance kept
    assert rows[filed["id"]]["body"] is None
    assert rows[filed["id"]]["subject"] is None
    assert rows[filed["id"]]["from_address"] is None
    assert rows[filed["id"]]["status"] == "filed"
    # new email: untouched
    assert rows[fresh["id"]]["body"] == "still under review"


def test_purge_rejects_negative_window():
    assert client.post("/api/emails/purge?older_than_days=-1").status_code == 400
