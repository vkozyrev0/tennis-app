"""PII H2: email body encrypted at rest, decrypted on read (docs/pii-hardening
-plan.md §H2). Verifies the ciphertext is stored, the API returns plaintext, and
detection/extraction still work against the encrypted-at-rest body.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.crypto import decrypt, encrypt
from app.db import get_conn
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


def test_crypto_roundtrip_and_passthrough():
    assert decrypt(encrypt("secret minor PII")) == "secret minor PII"
    assert encrypt("x") != "x"                    # actually encrypted
    assert decrypt("legacy plaintext") == "legacy plaintext"   # not a token → passthrough
    assert encrypt(None) is None and decrypt(None) is None
    assert encrypt("") == ""


def _raw_body(email_id):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT body FROM email_message WHERE id = %s", (email_id,))
        return cur.fetchone()["body"]


def test_body_encrypted_at_rest_but_api_returns_plaintext():
    t = _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    secret = "sensitive: minor address 123 Main St " + uuid.uuid4().hex
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "s", "body": secret, "from_address": "p@e.com"}))
    # create returns plaintext
    assert e["body"] == secret
    # ...but the column holds ciphertext, not the plaintext
    raw = _raw_body(e["id"])
    assert raw != secret and secret not in raw
    assert decrypt(raw) == secret
    # the list endpoint also returns plaintext
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json() if m["id"] == e["id"])
    assert row["body"] == secret


def test_detection_and_extraction_work_on_encrypted_body():
    t = _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "usta_number": usta, "first_name": "Enc", "last_name": "Rypt",
        "gender": "male", "age_division": "B14", "selection_status": "selected"}))
    # USTA # + division/events live ONLY in the (encrypted-at-rest) body
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "late entry",
        "body": f"player {usta} boys 14 singles and doubles", "from_address": "p@e.com"}))
    # detection reads the decrypted body
    d = _ok(client.post(f"/api/emails/{e['id']}/detect-player", json={}), 200)
    assert d["detected_usta"] == usta
    # extraction (surfaced in the list) reads the decrypted body
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json() if m["id"] == e["id"])
    assert row["detected_division"] == "B14"
    assert row["detected_events"] == "Singles, Doubles"
