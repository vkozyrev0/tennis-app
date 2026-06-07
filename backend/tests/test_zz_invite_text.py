"""Per-assignment invite text (GET /api/assignments/{id}/invite-text).

A ready-to-paste assignment email personalised to the official: their worked
days + roles, the site, and estimated pay. Named to sort last."""
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
        "name": "Invite Cup " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Dana", "last_name": "Ref " + uuid.uuid4().hex[:5],
        "email": "dana@example.com"}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def test_invite_text_personalised():
    t = _tournament()
    o = _official()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-02", "working_as": "roving_official"}))
    inv = _ok(client.get(f"/api/assignments/{a['id']}/invite-text"), 200)
    assert inv["official_email"] == "dana@example.com"
    assert "Invite Cup" in inv["subject"]
    assert inv["body"].startswith("Dear Dana,")
    assert "Roving Official" in inv["body"]   # role title-cased
    assert "Jun 02" in inv["body"]            # the worked day formatted
    assert "Estimated pay:" in inv["body"]


def test_invite_text_no_days_says_tbd():
    t = _tournament()
    o = _official()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    inv = _ok(client.get(f"/api/assignments/{a['id']}/invite-text"), 200)
    assert "TBD" in inv["subject"] or "TBD" in inv["body"]


def test_invite_text_404_for_unknown():
    assert client.get("/api/assignments/99999999/invite-text").status_code == 404
