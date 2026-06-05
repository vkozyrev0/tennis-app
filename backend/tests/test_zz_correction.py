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


def _rostered(tid, first, last):
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": usta, "first_name": first, "last_name": last,
        "gender": "male", "age_division": "B14", "selection_status": "selected"}))
    return usta


def _file_withdrawal(tid, usta, subject, body):
    """Create + classify + detect + bulk-populate an email into a withdrawal row."""
    e = _ok(client.post("/api/emails", json={
        "tournament_id": tid, "subject": subject, "body": body, "from_address": "p@e.com"}))
    pid = _ok(client.post(f"/api/emails/{e['id']}/detect-player", json={}), 200)["detected_player_id"]
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": tid, "classification": "withdrawal", "status": "new",
        "detected_player_id": pid})
    _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    return e


def test_apply_correction_rewrites_the_filed_row():
    t = _tournament()
    usta = _rostered(t["id"], "Will", "Withdraw")
    orig = _file_withdrawal(t["id"], usta, f"Withdraw {usta}", f"{usta} withdrawing due to injury")
    wd = next(w for w in client.get(f"/api/tournaments/{t['id']}/withdrawals").json()
              if w.get("usta_number") == usta)
    assert wd["source_email_id"] == orig["id"] and wd["reason"] == "injury"

    # correction: same player, illness instead of injury
    corr = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": f"Correction {usta}",
        "body": f"{usta} actually due to illness", "from_address": "p@e.com"}))
    client.put(f"/api/emails/{corr['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal", "status": "new",
        "detected_player_id": _ok(client.post(f"/api/emails/{corr['id']}/detect-player", json={}), 200)["detected_player_id"]})
    _ok(client.post(f"/api/emails/{corr['id']}/amends", json={"amends_email_id": orig["id"]}), 200)
    res = _ok(client.post(f"/api/emails/{corr['id']}/apply-correction"), 200)
    assert res["updated_row_id"] == wd["id"]

    # the SAME row is updated (no duplicate): re-pointed + reason re-applied
    wds = client.get(f"/api/tournaments/{t['id']}/withdrawals").json()
    mine = [w for w in wds if w.get("usta_number") == usta]
    assert len(mine) == 1
    assert mine[0]["source_email_id"] == corr["id"]
    assert mine[0]["reason"].lower() == "illness"  # re-applied from the correction


def test_apply_correction_requires_link_and_existing_row():
    t = _tournament()
    e = _ok(client.post("/api/emails", json={"tournament_id": t["id"], "subject": "x", "body": "y"}))
    # not linked → 400
    assert client.post(f"/api/emails/{e['id']}/apply-correction").status_code == 400
    # linked + classified, but the amended email has no filed row → 404
    orig = _ok(client.post("/api/emails", json={"tournament_id": t["id"], "subject": "o", "body": "z"}))
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal", "status": "new",
        "detected_player_id": None})
    _ok(client.post(f"/api/emails/{e['id']}/amends", json={"amends_email_id": orig["id"]}), 200)
    assert client.post(f"/api/emails/{e['id']}/apply-correction").status_code == 404


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
