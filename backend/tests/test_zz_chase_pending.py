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
