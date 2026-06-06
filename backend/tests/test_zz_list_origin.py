"""Filed-email origin on the late-entry / withdrawal lists.

A row filed from an email carries its `source_email_id` + `source_subject` (the
email's subject, joined in) so the UI can show "from email" vs "manual". A row
entered manually has both null.

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


def _player(tid, usta):
    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": usta, "first_name": "Pat", "last_name": "Player",
        "gender": "female", "age_division": "G14", "selection_status": "selected"}))


def _email(tid, subject):
    return _ok(client.post("/api/emails", json={
        "tournament_id": tid, "subject": subject, "body": "b", "from_address": "x@y.com"}))


def test_late_entry_carries_source_subject_when_filed():
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _player(t["id"], usta)
    subj = "Late entry req " + uuid.uuid4().hex[:6]
    em = _email(t["id"], subj)
    _ok(client.post(f"/api/tournaments/{t['id']}/late-entries", json={
        "usta_number": usta, "source_email_id": em["id"]}))
    row = client.get(f"/api/tournaments/{t['id']}/late-entries").json()[0]
    assert row["source_email_id"] == em["id"]
    assert row["source_subject"] == subj


def test_late_entry_manual_has_null_origin():
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _player(t["id"], usta)
    _ok(client.post(f"/api/tournaments/{t['id']}/late-entries", json={"usta_number": usta}))
    row = client.get(f"/api/tournaments/{t['id']}/late-entries").json()[0]
    assert row["source_email_id"] is None
    assert row["source_subject"] is None


def test_withdrawal_carries_source_subject_when_filed():
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _player(t["id"], usta)
    subj = "Withdrawal " + uuid.uuid4().hex[:6]
    em = _email(t["id"], subj)
    _ok(client.post(f"/api/tournaments/{t['id']}/withdrawals", json={
        "usta_number": usta, "reason": "illness", "source_email_id": em["id"]}))
    row = client.get(f"/api/tournaments/{t['id']}/withdrawals").json()[0]
    assert row["source_email_id"] == em["id"]
    assert row["source_subject"] == subj
