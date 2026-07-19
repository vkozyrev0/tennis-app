"""Email auto-ingest webhook (D4) — token auth, dedup, routing, encryption.

Named test_zz_* so logins sort after other modules (suite convention).
"""
import os
import uuid

import pytest
from fastapi.testclient import TestClient

from app.crypto import decrypt
from app.db import get_conn
from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)

TOKEN = "test-ingest-token-not-for-prod"


@pytest.fixture(autouse=True)
def _token_and_admin(monkeypatch):
    monkeypatch.setenv("INGEST_TOKEN", TOKEN)
    monkeypatch.delenv("INGEST_DEFAULT_TOURNAMENT_ID", raising=False)
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _tournament(**kw):
    body = {
        "name": "Ingest T " + uuid.uuid4().hex[:8],
        "type": "junior",
        "play_start_date": "2026-07-01",
        "play_end_date": "2026-07-04",
        **kw,
    }
    return _ok(client.post("/api/tournaments", json=body))


def _headers(**extra):
    h = {"X-Ingest-Token": TOKEN}
    h.update(extra)
    return h


# --------------------------------------------------------------------------
# Auth / enablement
# --------------------------------------------------------------------------

def test_status_reports_enabled():
    r = client.get("/api/ingest/status")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert "json" in body["endpoints"]


def test_disabled_without_token(monkeypatch):
    monkeypatch.delenv("INGEST_TOKEN", raising=False)
    r = client.post("/api/ingest/email", json={
        "subject": "hi", "body": "there",
    })
    assert r.status_code == 503
    assert "INGEST_TOKEN" in r.json()["detail"]


def test_wrong_token_401():
    r = client.post(
        "/api/ingest/email",
        headers={"X-Ingest-Token": "wrong"},
        json={"subject": "x", "body": "y"},
    )
    assert r.status_code == 401


def test_bearer_token_works():
    mid = f"<{uuid.uuid4().hex}@test>"
    r = client.post(
        "/api/ingest/email",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={
            "message_id": mid,
            "from_address": "parent@example.com",
            "subject": "please withdraw Jane Doe",
            "body": "She is injured and cannot play.",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["duplicate"] is False


# --------------------------------------------------------------------------
# Happy path + classification + encryption
# --------------------------------------------------------------------------

def test_ingest_json_classifies_and_encrypts_body():
    t = _tournament(ingest_address="macon-demo")
    mid = f"withdraw-{uuid.uuid4().hex}@example.com"
    body_text = "Please withdraw Sam Player from the tournament. USTA # 1234567890"
    r = client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": mid,
            "from_address": "mom@example.com",
            "to_address": "macon-demo@inbox.example.com",
            "subject": "Withdrawal request",
            "body": body_text,
        },
    )
    data = _ok(r, 201)
    assert data["tournament_id"] == t["id"]
    assert data["classification"] == "withdrawal"
    assert data["status"] == "new"
    assert data["duplicate"] is False

    # Encrypted at rest: ciphertext in DB ≠ plaintext; admin read decrypts.
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT body, to_address, ingest_source FROM email_message WHERE id = %s",
                (data["id"],),
            )
            row = cur.fetchone()
    assert row["body"] != body_text
    assert decrypt(row["body"]) == body_text
    assert row["to_address"] == "macon-demo@inbox.example.com"
    assert row["ingest_source"] == "webhook"

    em = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    hit = next((e for e in em if e["id"] == data["id"]), None)
    assert hit is not None
    assert hit["body"] == body_text
    assert hit["ingest_source"] == "webhook"
    assert hit["to_address"] == "macon-demo@inbox.example.com"


def test_dedup_by_message_id_returns_200():
    mid = f"dup-{uuid.uuid4().hex}@example.com"
    payload = {
        "message_id": mid,
        "from_address": "a@b.com",
        "subject": "late entry for kid",
        "body": "Can we still register late?",
    }
    first = _ok(client.post("/api/ingest/email", headers=_headers(), json=payload), 201)
    second = client.post("/api/ingest/email", headers=_headers(), json=payload)
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["duplicate"] is True
    assert body["id"] == first["id"]


def test_explicit_tournament_id():
    t = _tournament()
    mid = f"exp-{uuid.uuid4().hex}@example.com"
    data = _ok(client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": mid,
            "tournament_id": t["id"],
            "subject": "hotel stay",
            "body": "We are staying at the Marriott downtown.",
            "from_address": "dad@example.com",
        },
    ), 201)
    assert data["tournament_id"] == t["id"]
    assert data["classification"] == "hotel"


def test_bad_tournament_id_400():
    r = client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": f"bad-{uuid.uuid4().hex}@x",
            "tournament_id": 99999999,
            "subject": "x",
            "body": "y",
        },
    )
    assert r.status_code == 400


def test_default_tournament_env(monkeypatch):
    t = _tournament()
    monkeypatch.setenv("INGEST_DEFAULT_TOURNAMENT_ID", str(t["id"]))
    mid = f"def-{uuid.uuid4().hex}@example.com"
    data = _ok(client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": mid,
            "subject": "doubles pair request",
            "body": "Mia Langone and Chelsea Ie would like to pair for doubles.",
            "from_address": "p@example.com",
        },
    ), 201)
    assert data["tournament_id"] == t["id"]


def test_form_mailgun_style():
    t = _tournament(ingest_address="mg-route")
    mid = f"mg-{uuid.uuid4().hex}@mailgun"
    r = client.post(
        "/api/ingest/email/form",
        headers=_headers(),
        data={
            "sender": "parent@example.com",
            "recipient": "mg-route@mg.example.com",
            "subject": "cannot play Saturday morning",
            "body-plain": "My child has a time conflict and can't play after 9.",
            "Message-Id": f"<{mid}>",
        },
    )
    data = _ok(r, 201)
    assert data["tournament_id"] == t["id"]
    assert data["classification"] == "scheduling_avoidance"
    assert data["message_id"] == mid  # angle brackets stripped


def test_empty_message_400():
    r = client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={},
    )
    assert r.status_code == 400


def test_ingest_address_unique_per_active_tournament():
    addr = f"shared-{uuid.uuid4().hex[:6]}"
    _tournament(ingest_address=addr)
    r = client.post("/api/tournaments", json={
        "name": "Clash " + uuid.uuid4().hex[:6],
        "type": "junior",
        "play_start_date": "2026-08-01",
        "play_end_date": "2026-08-03",
        "ingest_address": addr,
    })
    assert r.status_code == 409
    assert "ingest address" in r.json()["detail"].lower()


def test_query_token_auth():
    mid = f"qtok-{uuid.uuid4().hex}@example.com"
    r = client.post(
        f"/api/ingest/email?token={TOKEN}",
        json={"message_id": mid, "subject": "hi", "body": "hello from query token"},
    )
    assert r.status_code == 201, r.text
