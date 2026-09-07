"""Gmail IMAP feed: stored settings, secret never leaked, latest-UID fetch."""
from __future__ import annotations

import uuid
from email.message import EmailMessage

import pytest
from fastapi.testclient import TestClient

from app.crypto import decrypt
from app.gmail_feed import message_to_payload, public_row
from app.main import app

client = TestClient(app)

_needs_db = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


@pytest.fixture
def _admin():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _rfc822(**kw) -> bytes:
    m = EmailMessage()
    m["From"] = kw.get("from_address", "parent@example.com")
    m["To"] = kw.get("to_address", "td@gmail.com")
    m["Subject"] = kw.get("subject", "Withdrawal")
    m["Message-ID"] = kw.get("message_id", f"<{uuid.uuid4().hex}@gmail.com>")
    m["Date"] = kw.get("date", "Wed, 27 May 2026 12:00:00 -0400")
    m.set_content(kw.get("body", "Please withdraw Jane Roe from singles."))
    return m.as_bytes()


def test_message_to_payload_reads_headers_and_body():
    raw = _rfc822(subject="Boys 14 Doubles", body="Pair Alex and Sam for doubles.")
    p = message_to_payload(raw, tournament_id=9)
    assert p.subject == "Boys 14 Doubles"
    assert p.from_address == "parent@example.com"
    assert "Pair Alex" in (p.body or "")
    assert p.ingest_source == "gmail"
    assert p.tournament_id == 9
    assert p.message_id


def test_public_row_never_includes_secret():
    row = public_row({
        "enabled": True, "gmail_address": "td@gmail.com",
        "secret_enc": "gAAAA-not-for-clients", "last_uid": 44,
    })
    assert "secret_enc" not in row
    assert "app_password" not in row
    assert row["has_secret"] is True
    assert row["gmail_address"] == "td@gmail.com"
    assert row["last_uid"] == 44


@_needs_db
def test_get_put_hides_password_and_keeps_cursor(_admin):
    got = client.get("/api/gmail-feed")
    assert got.status_code == 200, got.text
    body = got.json()
    assert "secret_enc" not in body
    assert "app_password" not in body
    assert "has_secret" in body
    r = client.put("/api/gmail-feed", json={
        "enabled": True,
        "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop",
        "poll_minutes": 20,
        "lookback_days": 5,
        "gmail_query": "newer_than:14d",
        "mailbox": "INBOX",
    })
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["enabled"] is True
    assert saved["gmail_address"] == "director@gmail.com"
    assert saved["has_secret"] is True
    assert saved["poll_minutes"] == 20
    assert saved["lookback_days"] == 5
    assert saved["gmail_query"] == "newer_than:14d"
    assert "app_password" not in saved
    # Blank password keeps the stored secret.
    r2 = client.put("/api/gmail-feed", json={"enabled": True, "gmail_address": "director@gmail.com"})
    assert r2.json()["has_secret"] is True
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT secret_enc FROM gmail_feed WHERE id = 1")
            enc = cur.fetchone()["secret_enc"]
    assert decrypt(enc) == "abcd efgh ijkl mnop"


class _FakeImap:
    def __init__(self, host, port=None):
        self.host = host
        self.port = port
        self._uv = b"99"

    def login(self, user, pw):
        assert user == "director@gmail.com"
        assert pw == "abcd efgh ijkl mnop"
        return ("OK", [b"Logged in"])

    def select(self, mailbox, readonly=False):
        return ("OK", [b"3"])

    def response(self, name):
        if name == "UIDVALIDITY":
            return ("OK", [self._uv])
        return ("OK", [None])

    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            return ("OK", [b"10 11 12"])
        if cmd == "FETCH":
            uid = int(args[0])
            raw = _rfc822(
                message_id=f"<uid-{uid}@gmail.com>",
                subject=f"Mail {uid}",
                body=f"Body of {uid}",
            )
            return ("OK", [(b"RFC822", raw)])
        return ("NO", [])

    def logout(self):
        return ("OK", [])


@_needs_db
def test_fetch_latest_ingests_new_uids_and_advances_cursor(monkeypatch, _admin):
    from app import gmail_feed as gf
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _FakeImap)
    # Reset cursor so 10/11/12 are new.
    client.put("/api/gmail-feed", json={
        "enabled": True,
        "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop",
    })
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 9, uidvalidity = 99 WHERE id = 1")
        conn.commit()
    r = client.post("/api/gmail-feed/fetch")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["imported"] == 3
    assert body["last_uid"] == 12
    assert body["last_status"] in {"ok", "partial"}
    # Second fetch with same UIDs: last_uid 12 → search 13:* empty on fake (still 10 11 12 filtered)
    r2 = client.post("/api/gmail-feed/fetch")
    assert r2.status_code == 200, r2.text
    assert r2.json()["imported"] == 0
    assert r2.json()["last_uid"] == 12


@_needs_db
def test_fetch_disabled_is_400(_admin):
    client.put("/api/gmail-feed", json={"enabled": False, "gmail_address": "director@gmail.com"})
    r = client.post("/api/gmail-feed/fetch")
    assert r.status_code == 400
    assert "disabled" in r.json()["detail"].lower()
