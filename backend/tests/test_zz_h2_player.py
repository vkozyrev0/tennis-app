"""PII H2 (extension): player contact fields (emails / phones) encrypted at rest,
decrypted on read. Verifies the importer encrypts and the players API decrypts.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.crypto import decrypt
from app.db import get_conn
from app.importer import _ext_player_initial
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


def _raw_contact(pid):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT emails, phones FROM player WHERE id = %s", (pid,))
        return cur.fetchone()


def test_importer_encrypts_contact_and_api_decrypts():
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    p = _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": "Con", "last_name": "Tact", "gender": "male"}))
    emails = "parent@example.com, player@example.com"
    phones = "555-1212, 555-3434"
    # the import path (B2a) writes the extended fields — exercise it directly
    with get_conn() as conn, conn.cursor() as cur:
        _ext_player_initial(cur, p["id"], {"emails": emails, "phones": phones})
        conn.commit()

    # stored ciphertext, not the plaintext
    raw = _raw_contact(p["id"])
    assert raw["emails"] != emails and "parent@example.com" not in raw["emails"]
    assert decrypt(raw["emails"]) == emails and decrypt(raw["phones"]) == phones

    # the API (list + detail) returns plaintext
    detail = client.get(f"/api/players/{p['id']}").json()
    assert detail["emails"] == emails and detail["phones"] == phones
    listed = next(x for x in client.get("/api/players").json() if x["id"] == p["id"])
    assert listed["emails"] == emails and listed["phones"] == phones


def test_null_contact_stays_null():
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    p = _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": "No", "last_name": "Contact", "gender": "female"}))
    detail = client.get(f"/api/players/{p['id']}").json()
    assert detail["emails"] is None and detail["phones"] is None
