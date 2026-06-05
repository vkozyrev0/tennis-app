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
    assert detail["birthdate"] is None


def _raw_birthdate(pid):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT birthdate FROM player WHERE id = %s", (pid,))
        return cur.fetchone()["birthdate"]


def test_birthdate_encrypted_at_rest_but_api_returns_the_date():
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    p = _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": "Dob", "last_name": "Test",
        "gender": "male", "birthdate": "2014-03-15"}))
    assert p["birthdate"] == "2014-03-15"          # API returns the date
    raw = _raw_birthdate(p["id"])
    assert raw != "2014-03-15" and "2014" not in raw   # ciphertext at rest
    assert decrypt(raw) == "2014-03-15"
    assert client.get(f"/api/players/{p['id']}").json()["birthdate"] == "2014-03-15"


def test_name_change_still_historizes_with_decryptable_birthdate():
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    p = _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": "Old", "last_name": "Name",
        "gender": "male", "birthdate": "2013-07-01"}))
    # rename → the trigger snapshots the old name + (encrypted) birthdate
    _ok(client.put(f"/api/players/{p['id']}", json={
        "usta_number": usta, "first_name": "New", "last_name": "Name",
        "gender": "male", "birthdate": "2013-07-01"}), code=200)
    hist = client.get(f"/api/players/{p['id']}/history").json()
    assert any(h["first_name"] == "Old" for h in hist)     # name historized
    # the history birthdate is decrypted on read (not a token)
    row = next(h for h in hist if h["first_name"] == "Old")
    assert row["birthdate"] == "2013-07-01"
