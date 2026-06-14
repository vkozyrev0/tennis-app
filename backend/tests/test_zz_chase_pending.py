"""Contact info on the assignment summary (chase pending responders).

The TD needs to nudge officials who haven't accepted/declined. The assignment
summary now carries the official's email + phone (plaintext for officials) so the
UI can offer mailto/tel links + a bulk "email pending" action.

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


def _official(email=None, phone=None):
    body = {"first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}
    if email:
        body["email"] = email
    if phone:
        body["phone"] = phone
    return _ok(client.post("/api/officials", json=body))


def _summary(tid, aid):
    return next(a for a in client.get(f"/api/tournaments/{tid}/assignments").json()
                if a["id"] == aid)


def test_assignment_carries_official_contact():
    t = _tournament()
    email = f"chase_{uuid.uuid4().hex[:6]}@example.com"
    o = _official(email=email, phone="555-0100")
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    s = _summary(t["id"], a["id"])
    assert s["official_email"] == email
    assert s["official_phone"] == "555-0100"
    # pending by default — the UI keys the chase helper off this
    assert s["response_status"] == "pending"


def test_contact_null_when_not_on_file():
    t = _tournament()
    o = _official()  # no email/phone
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    s = _summary(t["id"], a["id"])
    assert s["official_email"] is None
    assert s["official_phone"] is None


def test_pending_nudge_list():
    t = _tournament()
    email = f"nudge_{uuid.uuid4().hex[:6]}@example.com"
    o1 = _official(email=email)
    o2 = _official()  # no email
    a1 = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o1["id"]}))
    a2 = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o2["id"]}))
    # both pending by default → both appear, carrying the email (for the mailto
    # nudge) and first_name; the one with no email on file reports null.
    d = _ok(client.get(f"/api/tournaments/{t['id']}/pending"), 200)
    assert d["count"] == 2
    by_id = {p["assignment_id"]: p for p in d["pending"]}
    assert by_id[a1["id"]]["official_email"] == email
    assert by_id[a2["id"]]["official_email"] is None
    assert all(p["official_name"] and p.get("first_name") for p in d["pending"])


def test_pending_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/pending").status_code == 404


def test_nudge_records_last_contacted():
    t = _tournament()
    o = _official(email="nudge@example.com")
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    # fresh assignment — no outreach yet
    row = next(p for p in _ok(client.get(f"/api/tournaments/{t['id']}/pending"), 200)["pending"]
               if p["assignment_id"] == a["id"])
    assert row["last_nudged_at"] is None
    # mark it nudged → timestamp set + reflected in /pending
    marked = _ok(client.post(f"/api/assignments/{a['id']}/nudged"), 200)
    assert marked["last_nudged_at"]
    row2 = next(p for p in _ok(client.get(f"/api/tournaments/{t['id']}/pending"), 200)["pending"]
                if p["assignment_id"] == a["id"])
    assert row2["last_nudged_at"] is not None
    # bulk mark (Nudge all) stamps every pending row
    assert _ok(client.post(f"/api/tournaments/{t['id']}/pending/nudged"), 200)["marked"] >= 1


def test_nudge_404s():
    assert client.post("/api/assignments/99999999/nudged").status_code == 404
    assert client.post("/api/tournaments/99999999/pending/nudged").status_code == 404
