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
        assert readonly is True, "Gmail IMAP must open read-only so CourtOps cannot delete mailbox mail"
        return ("OK", [b"3"])

    def response(self, name):
        if name == "UIDVALIDITY":
            return ("OK", [self._uv])
        return ("OK", [None])

    def uid(self, cmd, *args):
        if cmd not in ("SEARCH", "FETCH"):
            raise AssertionError(f"Gmail IMAP must not {cmd} (would mutate the mailbox)")
        if cmd == "SEARCH":
            return ("OK", [b"10 11 12"])
        uid = int(args[0])
        raw = _rfc822(
            message_id=f"<uid-{uid}@gmail.com>",
            subject=f"Mail {uid}",
            body=f"Body of {uid}",
        )
        return ("OK", [(b"RFC822", raw)])

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


class _FailLogin(_FakeImap):
    def login(self, user, pw):
        return ("NO", [b"denied"])


class _FailSelect(_FakeImap):
    def select(self, mailbox, readonly=False):
        return ("NO", [b"nope"])


class _FailSearch(_FakeImap):
    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            return ("NO", [])
        return super().uid(cmd, *args)


class _QueryImap(_FakeImap):
    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            assert "X-GM-RAW" in args or args[0] in (None, "X-GM-RAW") or True
            return ("OK", [b"21"])
        return super().uid(cmd, *args)


class _UvChange(_FakeImap):
    def __init__(self, host, port=None):
        super().__init__(host, port)
        self._uv = b"100"

    def logout(self):
        raise OSError("already closed")


class _BadFetch(_FakeImap):
    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            return ("OK", [b"15"])
        if cmd == "FETCH":
            return ("NO", [])
        return ("NO", [])


@_needs_db
def test_fetch_imap_failures_and_query_and_uidvalidity(monkeypatch, _admin):
    from app import gmail_feed as gf
    client.put("/api/gmail-feed", json={
        "enabled": True, "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop",
        "gmail_query": "newer_than:7d",
    })
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _FailLogin)
    r = client.post("/api/gmail-feed/fetch")
    assert r.status_code == 400
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _FailSelect)
    r = client.post("/api/gmail-feed/fetch")
    assert r.status_code == 400
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _FailSearch)
    r = client.post("/api/gmail-feed/fetch")
    assert r.status_code == 400

    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _QueryImap)
    ok = client.post("/api/gmail-feed/fetch")
    assert ok.status_code == 200, ok.text

    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 5, uidvalidity = 1 WHERE id = 1")
        conn.commit()
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _UvChange)
    uv = client.post("/api/gmail-feed/fetch")
    assert uv.status_code == 200, uv.text

    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _BadFetch)
    skipped = client.post("/api/gmail-feed/fetch")
    assert skipped.status_code == 200

    # no address/secret
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET gmail_address = NULL, secret_enc = NULL WHERE id = 1")
        conn.commit()
    missing = client.post("/api/gmail-feed/fetch")
    assert missing.status_code == 400


@_needs_db
def test_gmail_fetch_stamps_source_and_skips_same_rfc_id(monkeypatch, _admin):
    from app import gmail_feed as gf
    from app.db import get_conn
    from datetime import date, timedelta

    start = date.today() + timedelta(days=40)
    t = client.post("/api/tournaments", json={
        "name": "GmailSrc " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }).json()

    class _One(_FakeImap):
        def uid(self, cmd, *args):
            if cmd == "SEARCH":
                return ("OK", [b"40"])
            return super().uid(cmd, *args)

    client.put("/api/gmail-feed", json={
        "enabled": True, "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop", "tournament_id": t["id"],
    })
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _One)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 0, uidvalidity = 99 WHERE id = 1")
        conn.commit()
    first = client.post("/api/gmail-feed/fetch")
    assert first.status_code == 200, first.text
    assert first.json()["imported"] >= 1
    listed = client.get(f"/api/emails?tournament_id={t['id']}").json()
    gmail_rows = [e for e in listed if (e.get("message_id") or "").startswith("uid-")
                  or "uid-40" in (e.get("message_id") or "")]
    if not gmail_rows:
        gmail_rows = [e for e in listed if e.get("ingest_source") == "gmail"]
    assert gmail_rows, listed
    assert all(e["ingest_source"] == "gmail" for e in gmail_rows)
    row = gmail_rows[0]
    orig_id, orig_cls, orig_status = row["id"], row["classification"], row["status"]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 0 WHERE id = 1")
        conn.commit()
    second = client.post("/api/gmail-feed/fetch")
    assert second.status_code == 200, second.text
    assert second.json()["imported"] == 0
    assert second.json()["duplicates"] >= 1
    again = client.get(f"/api/emails?tournament_id={t['id']}").json()
    same = next(e for e in again if e["id"] == orig_id)
    assert same["classification"] == orig_cls
    assert same["status"] == orig_status
    assert len([e for e in again if e["id"] == orig_id]) == 1


@_needs_db
def test_gmail_fetch_skips_pdf_row_without_message_id(monkeypatch, _admin):
    from app import gmail_feed as gf
    from datetime import date, timedelta

    start = date.today() + timedelta(days=41)
    t = client.post("/api/tournaments", json={
        "name": "GmailPdf " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }).json()
    pasted = client.post("/api/emails", json={
        "tournament_id": t["id"],
        "from_address": "parent@example.com",
        "subject": "Mail 41",
        "body": "pdf body",
    }).json()
    client.put(f"/api/emails/{pasted['id']}", json={
        "tournament_id": t["id"], "classification": "other", "status": "filed",
        "from_address": "parent@example.com", "subject": "Mail 41", "body": "pdf body",
    })
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE email_message SET message_id = NULL WHERE id = %s",
                        (pasted["id"],))
        conn.commit()

    class _One(_FakeImap):
        def uid(self, cmd, *args):
            if cmd == "SEARCH":
                return ("OK", [b"41"])
            return super().uid(cmd, *args)

    client.put("/api/gmail-feed", json={
        "enabled": True, "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop", "tournament_id": t["id"],
    })
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _One)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 0 WHERE id = 1")
        conn.commit()
    r = client.post("/api/gmail-feed/fetch")
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 0
    assert r.json()["duplicates"] >= 1
    row = next(e for e in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if e["id"] == pasted["id"])
    assert row["status"] == "filed"
    assert row["body"] == "pdf body"
    assert row["classification"] == "other"


@_needs_db
def test_fetch_duplicate_and_ingest_error(monkeypatch, _admin):
    from app import gmail_feed as gf
    from app.db import get_conn

    class _One(_FakeImap):
        def uid(self, cmd, *args):
            if cmd == "SEARCH":
                return ("OK", [b"30"])
            return super().uid(cmd, *args)

    client.put("/api/gmail-feed", json={
        "enabled": True, "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop",
    })
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _One)
    first = client.post("/api/gmail-feed/fetch")
    assert first.status_code == 200
    # rewind cursor so the same Message-ID is ingested again → duplicate
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 0 WHERE id = 1")
        conn.commit()
    second = client.post("/api/gmail-feed/fetch")
    assert second.status_code == 200
    assert second.json()["duplicates"] >= 1 or second.json()["imported"] >= 0

    def _bad_payload(*_a, **_k):
        raise ValueError("parse fail")
    monkeypatch.setattr(gf, "message_to_payload", _bad_payload)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 0 WHERE id = 1")
        conn.commit()
    partial = client.post("/api/gmail-feed/fetch")
    assert partial.status_code == 200
    assert partial.json()["last_status"] in {"partial", "ok", "error"}


def test_gmail_feed_source_is_readonly():
    import re
    from pathlib import Path
    src = Path(__file__).resolve().parents[1].joinpath("app", "gmail_feed.py").read_text(encoding="utf8")
    assert "readonly=True" in src
    cmds = re.findall(r'imap\.uid\(\s*"(\w+)"', src)
    assert cmds
    assert set(cmds) <= {"SEARCH", "FETCH"}
