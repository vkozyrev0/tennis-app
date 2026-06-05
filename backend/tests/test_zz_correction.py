"""Correction / amendment handling: link a follow-up email to the one it amends,
surface the lineage both ways, flag the superseded original (migration 0034)."""
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
        "tournament_id": tid, "subject": subject, "body": "b", "from_address": "p@e.com"}))


def _row(tid, eid):
    return next(m for m in client.get(f"/api/emails?tournament_id={tid}").json() if m["id"] == eid)


def test_amendment_links_and_supersedes():
    t = _tournament()
    orig = _email(t["id"], "Withdraw: injury")
    corr = _email(t["id"], "Correction: actually illness")
    res = _ok(client.post(f"/api/emails/{corr['id']}/amends",
                          json={"amends_email_id": orig["id"]}), 200)
    assert res["amends_email_id"] == orig["id"]
    assert res["amends_subject"] == "Withdraw: injury"
    assert res["superseded"] is False
    # the original is now flagged superseded
    assert _row(t["id"], orig["id"])["superseded"] is True
    # clearing the link removes both sides
    _ok(client.post(f"/api/emails/{corr['id']}/amends", json={"amends_email_id": None}), 200)
    assert _row(t["id"], corr["id"])["amends_email_id"] is None
    assert _row(t["id"], orig["id"])["superseded"] is False


def test_amendment_rejects_self_and_cross_tournament():
    t1, t2 = _tournament(), _tournament()
    a = _email(t1["id"], "a")
    b = _email(t2["id"], "b")
    assert client.post(f"/api/emails/{a['id']}/amends",
                       json={"amends_email_id": a["id"]}).status_code == 400  # self
    assert client.post(f"/api/emails/{a['id']}/amends",
                       json={"amends_email_id": b["id"]}).status_code == 400  # cross-tournament
    assert client.post(f"/api/emails/{a['id']}/amends",
                       json={"amends_email_id": 10_000_000}).status_code == 404


def test_deleting_original_clears_the_link_not_the_correction():
    t = _tournament()
    orig = _email(t["id"], "orig")
    corr = _email(t["id"], "corr")
    _ok(client.post(f"/api/emails/{corr['id']}/amends",
                    json={"amends_email_id": orig["id"]}), 200)
    assert client.delete(f"/api/emails/{orig['id']}").status_code == 204
    # the correction survives; its amends link is nulled (ON DELETE SET NULL)
    row = _row(t["id"], corr["id"])
    assert row["amends_email_id"] is None
    assert row["amends_subject"] is None
