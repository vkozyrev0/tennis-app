"""Outlook / Microsoft Graph feed: stored settings, secret never leaked, cursor fetch."""
from __future__ import annotations

import io
import json
import urllib.error
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.crypto import decrypt
from app.outlook_feed import (
    _DEFAULT_SECRET,
    _call_http,
    _email_address,
    _http_json,
    _iso,
    _keep_message,
    _redact,
    _since_cutoff,
    graph_message_to_payload,
    load_feed,
    normalize_client_id,
    public_row,
    save_feed,
)
from app.main import app

client = TestClient(app)

_needs_db = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)

TD_TENANT = "4c0cbcf5-4d26-4983-afdb-cc67e4754e4a"
TD_CLIENT = "api://1fdab846-8104-468e-a650-149c2ddc40c6"
TD_GUID = "1fdab846-8104-468e-a650-149c2ddc40c6"
TD_MAILBOX = "TD@myadllc.com"
TD_SECRET = "test-outlook-client-secret"
TD_EXPIRES = "9/7/2028"


@pytest.fixture
def _admin():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _assert_no_secret(body) -> None:
    dumped = json.dumps(body) if not isinstance(body, str) else body
    assert TD_SECRET not in dumped
    if _DEFAULT_SECRET:
        assert _DEFAULT_SECRET not in dumped
    if isinstance(body, dict) and "detail" not in body:
        assert "secret_enc" not in body
        assert "client_secret" not in body
        assert "has_secret" in body


def _graph_msg(**kw) -> dict:
    received = kw.get("received", (datetime.now(timezone.utc) - timedelta(hours=1)))
    if isinstance(received, datetime):
        received = received.strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "id": kw.get("id", uuid.uuid4().hex),
        "internetMessageId": kw.get("message_id", f"<{uuid.uuid4().hex}@outlook.test>"),
        "subject": kw.get("subject", "Withdrawal"),
        "body": {
            "contentType": kw.get("content_type", "text"),
            "content": kw.get("body", "Please withdraw Jane Roe from singles."),
        },
        "from": {"emailAddress": {"name": "Pat", "address": kw.get("from_address", "parent@example.com")}},
        "toRecipients": [
            {"emailAddress": {"address": kw.get("to_address", TD_MAILBOX)}},
        ],
        "receivedDateTime": received,
    }


class _FakeGraph:
    def __init__(self, messages=None, token="fake-token"):
        self.messages = list(messages or [])
        self.token = token
        self.token_urls = []
        self.mail_urls = []
        self.token_bodies = []

    def __call__(self, method, url, *, headers=None, data=None, timeout=30):
        method = (method or "").upper()
        if "oauth2/v2.0/token" in url:
            assert method == "POST"
            self.token_urls.append(url)
            body = data.decode() if isinstance(data, (bytes, bytearray)) else (data or "")
            self.token_bodies.append(body)
            assert "grant_type=client_credentials" in body
            assert "graph.microsoft.com%2F.default" in body or "graph.microsoft.com/.default" in body
            assert "api://" not in body
            assert f"client_id={TD_GUID}" in body
            return 200, {"access_token": self.token}
        if "/messages" in url:
            assert method == "GET", (
                "Graph mail calls must be GET — never DELETE/PATCH mailbox messages"
            )
            self.mail_urls.append(url)
            assert (headers or {}).get("Authorization") == f"Bearer {self.token}"
            return 200, {"value": self.messages}
        raise AssertionError(url)


def test_graph_message_to_payload_maps_fields():
    msg = _graph_msg(
        subject="Boys 14 Doubles",
        body="Pair Alex and Sam for doubles.",
        message_id="<abc@outlook.test>",
    )
    p = graph_message_to_payload(msg, tournament_id=9)
    assert p.subject == "Boys 14 Doubles"
    assert p.from_address == "parent@example.com"
    assert TD_MAILBOX.lower() in (p.to_address or "").lower() or TD_MAILBOX in (p.to_address or "")
    assert "Pair Alex" in (p.body or "")
    assert p.ingest_source == "outlook"
    assert p.ingest_source != "gmail"
    assert p.tournament_id == 9
    assert p.message_id


def test_graph_message_to_payload_html_preview_and_fallbacks():
    html = graph_message_to_payload({
        "id": "graph-1",
        "subject": "Hi",
        "body": {"contentType": "html", "content": "<p>Please <b>withdraw</b></p>"},
        "from": "pat@example.com",
        "toRecipients": [{"address": "td@example.com"}, "skip", None, {"emailAddress": {}}],
        "receivedDateTime": "not-a-date",
    })
    assert html.ingest_source == "outlook"
    assert html.from_address == "pat@example.com"
    assert "withdraw" in (html.body or "").lower()
    assert html.message_id == "graph-1"
    assert html.received_at is None

    preview = graph_message_to_payload({
        "internetMessageId": "<x@y>",
        "bodyPreview": "preview only",
        "from": {"address": "a@b.c"},
        "toRecipients": [],
        "receivedDateTime": "2026-09-01T12:00:00Z",
    })
    assert preview.body == "preview only"
    assert preview.from_address == "a@b.c"
    assert preview.received_at is not None

    empty = graph_message_to_payload({})
    assert empty.ingest_source == "outlook"
    assert empty.body is None
    assert empty.to_address is None


def test_public_row_never_includes_secret():
    row = public_row({
        "enabled": True, "mailbox": TD_MAILBOX,
        "secret_enc": "gAAAA-not-for-clients",
        "last_received_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 9, 2, tzinfo=timezone.utc),
    })
    _assert_no_secret(row)
    assert row["has_secret"] is True
    assert row["mailbox"] == TD_MAILBOX
    assert "T" in (row["last_received_at"] or "")
    none = public_row(None)
    assert none["has_secret"] is False
    assert none["tenant_id"] == TD_TENANT
    assert none["client_id"] == TD_CLIENT
    assert none["mailbox"] == TD_MAILBOX
    assert none["client_secret_expires"] == TD_EXPIRES
    _assert_no_secret(none)


def test_normalize_client_id_strips_api_prefix():
    assert normalize_client_id(TD_CLIENT) == TD_GUID
    assert normalize_client_id("API://" + TD_GUID) == TD_GUID
    assert normalize_client_id(TD_GUID) == TD_GUID
    assert normalize_client_id(None) == ""
    assert normalize_client_id("api://") == ""
    assert normalize_client_id("  ") == ""


def test_helpers_addresses_cutoff_iso_redact():
    assert _email_address(None) is None
    assert _email_address("") is None
    assert _email_address(12) is None
    assert _email_address("a@b.c") == "a@b.c"
    assert _email_address({"emailAddress": {"address": "x@y.z"}}) == "x@y.z"
    assert _email_address({"address": "x@y.z"}) == "x@y.z"
    assert _email_address({"emailAddress": "nope"}) is None
    assert _iso(datetime(2026, 9, 1, 12, 0, 0)).endswith("Z")
    cut, exclusive = _since_cutoff({"last_received_at": "2026-09-01T00:00:00Z"})
    assert exclusive is True
    cut2, exclusive2 = _since_cutoff({"last_received_at": "nope", "lookback_days": 3})
    assert exclusive2 is False
    cut3, exclusive3 = _since_cutoff({"last_received_at": datetime(2026, 9, 1, 12, 0, 0)})
    assert exclusive3 is True
    assert cut3.tzinfo is not None
    assert "[redacted]" in _redact(f"leak {TD_SECRET}", TD_SECRET)
    assert TD_SECRET not in _redact(f"leak {TD_SECRET}", TD_SECRET)
    msg = _graph_msg()
    assert _keep_message(msg, datetime.now(timezone.utc) - timedelta(days=2), False) is True
    assert _keep_message({"receivedDateTime": None}, datetime.now(timezone.utc), True) is False
    assert _keep_message({"receivedDateTime": None}, datetime.now(timezone.utc), False) is True


@_needs_db
def test_get_put_hides_secret_and_keeps_defaults(_admin):
    got = client.get("/api/outlook-feed")
    assert got.status_code == 200, got.text
    body = got.json()
    _assert_no_secret(body)
    assert body["tenant_id"] == TD_TENANT
    assert body["client_id"] == TD_CLIENT
    assert body["mailbox"] == TD_MAILBOX
    assert body["client_secret_expires"] == TD_EXPIRES
    assert body["has_secret"] is False
    r = client.put("/api/outlook-feed", json={
        "enabled": True,
        "tenant_id": TD_TENANT,
        "client_id": TD_CLIENT,
        "client_secret": TD_SECRET,
        "mailbox": TD_MAILBOX,
        "poll_minutes": 20,
        "lookback_days": 5,
        "mail_query": "from:playtennis.usta.com",
        "client_secret_expires": TD_EXPIRES,
    })
    assert r.status_code == 200, r.text
    saved = r.json()
    _assert_no_secret(saved)
    assert saved["enabled"] is True
    assert saved["mailbox"] == TD_MAILBOX
    assert saved["has_secret"] is True
    assert saved["poll_minutes"] == 20
    assert saved["lookback_days"] == 5
    assert saved["mail_query"] == "from:playtennis.usta.com"
    r2 = client.put("/api/outlook-feed", json={"enabled": True, "mailbox": TD_MAILBOX})
    assert r2.json()["has_secret"] is True
    _assert_no_secret(r2.json())
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT secret_enc FROM outlook_feed WHERE id = 1")
            enc = cur.fetchone()["secret_enc"]
    assert decrypt(enc) == TD_SECRET


@_needs_db
def test_save_feed_coerces_bad_ints_and_empty_ids(_admin):
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            saved = save_feed(cur, {
                "enabled": False,
                "tenant_id": "",
                "client_id": "",
                "mailbox": "",
                "poll_minutes": "x",
                "lookback_days": {},
                "tournament_id": "zz",
                "client_secret": "  ",
            })
            assert saved["poll_minutes"] == 15
            assert saved["lookback_days"] == 7
            assert saved["tenant_id"] == TD_TENANT
            assert saved["mailbox"] == TD_MAILBOX
            cleared = save_feed(cur, {"tournament_id": ""})
            assert cleared["tournament_id"] is None


@_needs_db
def test_load_feed_reinserts_without_baking_a_secret(_admin):
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM outlook_feed WHERE id = 1")
            row = load_feed(cur)
            assert row.get("mailbox") == TD_MAILBOX
            assert not row.get("secret_enc")
            cur.execute("UPDATE outlook_feed SET secret_enc = NULL WHERE id = 1")
            row2 = load_feed(cur)
            assert not row2.get("secret_enc")


def test_load_feed_fallback_when_no_row():
    class _Cur:
        def execute(self, *_a, **_k):
            return None
        def fetchone(self):
            return None
    row = load_feed(_Cur())
    assert row["mailbox"] == TD_MAILBOX
    assert not row.get("secret_enc")


@_needs_db
def test_fetch_latest_ingests_and_advances_cursor(monkeypatch, _admin):
    from app import outlook_feed as of
    now = datetime.now(timezone.utc)
    msgs = [
        _graph_msg(message_id=f"<o-{i}@outlook.test>", subject=f"Mail {i}",
                   received=now - timedelta(minutes=30 - i), body=f"Body of {i}")
        for i in (1, 2, 3)
    ]
    fake = _FakeGraph(msgs)
    monkeypatch.setattr(of, "_http_json", fake)
    client.put("/api/outlook-feed", json={
        "enabled": True,
        "tenant_id": TD_TENANT,
        "client_id": TD_CLIENT,
        "client_secret": TD_SECRET,
        "mailbox": TD_MAILBOX,
        "mail_query": "",
    })
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL WHERE id = 1")
        conn.commit()
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 200, r.text
    body = r.json()
    _assert_no_secret(body)
    assert body["imported"] == 3
    assert body["last_received_at"]
    assert body["last_status"] in {"ok", "partial"}
    assert fake.token_urls and TD_TENANT in fake.token_urls[0]
    assert fake.mail_urls and "/users/" in fake.mail_urls[0]
    r2 = client.post("/api/outlook-feed/fetch")
    assert r2.status_code == 200, r2.text
    assert r2.json()["imported"] == 0
    _assert_no_secret(r2.json())


@_needs_db
def test_fetch_disabled_is_400(_admin):
    client.put("/api/outlook-feed", json={"enabled": False, "mailbox": TD_MAILBOX})
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 400
    assert "disabled" in r.json()["detail"].lower()
    _assert_no_secret(r.json())


@_needs_db
def test_fetch_token_and_graph_failures_do_not_leak_secret(monkeypatch, _admin):
    from app import outlook_feed as of
    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT,
    })

    def _tok_fail(method, url, **_k):
        if "token" in url:
            return 401, {"error": "invalid_client", "error_description": TD_SECRET}
        return 200, {"value": []}

    monkeypatch.setattr(of, "_http_json", _tok_fail)
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code in (400, 502)
    _assert_no_secret(r.text)
    _assert_no_secret(r.json())

    def _graph_fail(method, url, **_k):
        if "token" in url:
            return 200, {"access_token": "tok"}
        return 403, {"error": {"message": f"denied {TD_SECRET}"}}

    monkeypatch.setattr(of, "_http_json", _graph_fail)
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code in (400, 502)
    _assert_no_secret(r.text)

    def _boom(*_a, **_k):
        raise OSError(f"connection reset {TD_SECRET}")

    monkeypatch.setattr(of, "_http_json", _boom)
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 502
    _assert_no_secret(r.text)


@_needs_db
def test_fetch_mail_query_missing_fields_and_partial(monkeypatch, _admin):
    from app import outlook_feed as of
    from app.db import get_conn

    class _Search(_FakeGraph):
        def __call__(self, method, url, **kw):
            result = super().__call__(method, url, **kw)
            if "/messages" in url:
                decoded = urllib.parse.unquote(url)
                assert "$search" in decoded
                assert "$orderby" not in decoded
            return result

    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "mail_query": "from:playtennis.usta.com",
    })
    monkeypatch.setattr(of, "_http_json", _Search([_graph_msg(message_id="<q@outlook.test>")]))
    ok = client.post("/api/outlook-feed/fetch")
    assert ok.status_code == 200, ok.text

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE outlook_feed SET mailbox = '', tenant_id = '', client_id = '' WHERE id = 1"
            )
        conn.commit()
    missing = client.post("/api/outlook-feed/fetch")
    assert missing.status_code == 400
    _assert_no_secret(missing.text)

    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT, "client_secret": TD_SECRET,
    })
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET enabled = TRUE, mailbox = '' WHERE id = 1")
        conn.commit()
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 400

    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "tenant_id": TD_TENANT,
        "client_id": "api://", "client_secret": TD_SECRET,
    })
    # empty guid after normalize
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET client_id = 'api://' WHERE id = 1")
        conn.commit()
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 400

    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "tenant_id": TD_TENANT,
        "client_id": TD_CLIENT, "client_secret": TD_SECRET,
    })
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET tenant_id = '' WHERE id = 1")
        conn.commit()
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 400


@_needs_db
def test_outlook_fetch_stamps_source_and_skips_same_internet_message_id(monkeypatch, _admin):
    from app import outlook_feed as of
    from app.db import get_conn
    from datetime import date, timedelta

    start = date.today() + timedelta(days=42)
    t = client.post("/api/tournaments", json={
        "name": "OlSrc " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }).json()
    mid = f"<ol-{uuid.uuid4().hex}@outlook.test>"
    msg = _graph_msg(message_id=mid, subject="Outlook source mail",
                     from_address="parent@example.com")
    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT, "tournament_id": t["id"],
    })
    monkeypatch.setattr(of, "_http_json", _FakeGraph([msg]))
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL WHERE id = 1")
        conn.commit()
    first = client.post("/api/outlook-feed/fetch")
    assert first.status_code == 200, first.text
    assert first.json()["imported"] >= 1
    listed = client.get(f"/api/emails?tournament_id={t['id']}").json()
    rows = [e for e in listed if e.get("ingest_source") == "outlook"]
    assert rows, listed
    row = rows[0]
    orig_id, orig_cls, orig_status = row["id"], row["classification"], row["status"]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL WHERE id = 1")
        conn.commit()
    second = client.post("/api/outlook-feed/fetch")
    assert second.status_code == 200
    assert second.json()["imported"] == 0
    assert second.json()["duplicates"] >= 1
    same = next(e for e in client.get(f"/api/emails?tournament_id={t['id']}").json()
                if e["id"] == orig_id)
    assert same["classification"] == orig_cls
    assert same["status"] == orig_status


@_needs_db
def test_outlook_fetch_skips_pdf_row_without_message_id(monkeypatch, _admin):
    from app import outlook_feed as of
    from app.db import get_conn
    from datetime import date, timedelta

    start = date.today() + timedelta(days=43)
    t = client.post("/api/tournaments", json={
        "name": "OlPdf " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }).json()
    pasted = client.post("/api/emails", json={
        "tournament_id": t["id"],
        "from_address": "parent@example.com",
        "subject": "PDF then Outlook",
        "body": "pdf only",
    }).json()
    client.put(f"/api/emails/{pasted['id']}", json={
        "tournament_id": t["id"], "classification": "hotel", "status": "filed",
        "from_address": "parent@example.com", "subject": "PDF then Outlook",
        "body": "pdf only",
    })
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE email_message SET message_id = NULL WHERE id = %s",
                        (pasted["id"],))
        conn.commit()
    msg = _graph_msg(message_id=f"<ol-pdf-{uuid.uuid4().hex}@outlook.test>",
                     subject="PDF then Outlook", from_address="parent@example.com")
    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT, "tournament_id": t["id"],
    })
    monkeypatch.setattr(of, "_http_json", _FakeGraph([msg]))
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL WHERE id = 1")
        conn.commit()
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 0
    assert r.json()["duplicates"] >= 1
    row = next(e for e in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if e["id"] == pasted["id"])
    assert row["status"] == "filed"
    assert row["classification"] == "hotel"
    assert row["body"] == "pdf only"


@_needs_db
def test_fetch_duplicate_and_ingest_error(monkeypatch, _admin):
    from app import outlook_feed as of
    from app.db import get_conn

    mid = f"<dup-{uuid.uuid4().hex}@outlook.test>"
    msg = _graph_msg(message_id=mid, subject="Dup mail")
    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT,
    })
    monkeypatch.setattr(of, "_http_json", _FakeGraph([msg]))
    first = client.post("/api/outlook-feed/fetch")
    assert first.status_code == 200
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL WHERE id = 1")
        conn.commit()
    second = client.post("/api/outlook-feed/fetch")
    assert second.status_code == 200
    assert second.json()["duplicates"] >= 1 or second.json()["imported"] >= 0

    def _bad_payload(*_a, **_k):
        raise ValueError("parse fail")
    monkeypatch.setattr(of, "graph_message_to_payload", _bad_payload)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL WHERE id = 1")
        conn.commit()
    partial = client.post("/api/outlook-feed/fetch")
    assert partial.status_code == 200
    assert partial.json()["last_status"] in {"partial", "ok", "error"}


@_needs_db
def test_fetch_token_payload_edges_and_batch_cap(monkeypatch, _admin):
    from app import outlook_feed as of
    from app.db import get_conn

    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT,
    })

    def _no_token(method, url, **_k):
        if "token" in url:
            return 200, {"token_type": "Bearer"}
        return 200, {"value": []}

    monkeypatch.setattr(of, "_http_json", _no_token)
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 400

    def _token_list(method, url, **_k):
        if "token" in url:
            return {"access_token": "tok"}  # non-tuple
        return 200, "not-a-dict"

    monkeypatch.setattr(of, "_http_json", _token_list)
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 400

    now = datetime.now(timezone.utc)
    msgs = [_graph_msg(
        message_id=f"<cap-{i}@outlook.test>",
        subject=f"Cap {i}",
        received=now - timedelta(minutes=60 - i),
        body=f"cap body {i}",
    ) for i in range(51)]
    msgs.append("skip-me")
    fake = _FakeGraph(msgs)

    def _odd(method, url, **kw):
        if "token" in url:
            return 200, {"access_token": "tok"}
        if "/messages" in url:
            return 200, {"value": None}
        raise AssertionError(url)

    monkeypatch.setattr(of, "_http_json", _odd)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL WHERE id = 1")
        conn.commit()
    empty = client.post("/api/outlook-feed/fetch")
    assert empty.status_code == 200
    assert empty.json()["imported"] == 0

    def _not_list(method, url, **_k):
        if "token" in url:
            return 200, {"access_token": "tok"}
        return 200, {"value": {"nope": 1}}

    monkeypatch.setattr(of, "_http_json", _not_list)
    client.post("/api/outlook-feed/fetch")

    monkeypatch.setattr(of, "_http_json", fake)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL WHERE id = 1")
        conn.commit()
    capped = client.post("/api/outlook-feed/fetch")
    assert capped.status_code == 200, capped.text
    assert capped.json()["imported"] == 50
    assert capped.json()["fetched"] == 50

    def _server(method, url, **_k):
        return 500, {"error": "boom"}

    monkeypatch.setattr(of, "_http_json", _server)
    boom = client.post("/api/outlook-feed/fetch")
    assert boom.status_code == 502
    _assert_no_secret(boom.text)


@_needs_db
def test_mailbox_change_resets_cursor(_admin):
    from app.db import get_conn
    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
    })
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = now() WHERE id = 1")
        conn.commit()
    r = client.put("/api/outlook-feed", json={"enabled": True, "mailbox": "other@myadllc.com"})
    assert r.status_code == 200
    assert r.json()["last_received_at"] in (None, "")
    client.put("/api/outlook-feed", json={"mailbox": TD_MAILBOX})


@_needs_db
def test_frontend_and_get_defaults_launch(_admin):
    page = client.get("/")
    assert page.status_code == 200
    html = page.text
    assert 'id="panel-outlook"' in html
    assert 'id="outlook-feed-form"' in html
    assert 'Directory (tenant) ID' in html or "tenant_id" in html
    assert TD_SECRET not in html
    got = client.get("/api/outlook-feed")
    assert got.status_code == 200
    body = got.json()
    assert body["tenant_id"] == TD_TENANT
    assert body["mailbox"] == TD_MAILBOX
    assert "has_secret" in body
    _assert_no_secret(body)


def test_http_json_success_and_errors(monkeypatch):
    class _Resp:
        status = 200
        def __init__(self, raw=b'{"ok": true}'):
            self._raw = raw
        def read(self):
            return self._raw
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    monkeypatch.setattr("app.outlook_feed._urlopen", lambda *a, **k: _Resp())
    status, payload = _http_json(
        "GET", "https://graph.microsoft.com/v1.0/me",
        headers={"Accept": "application/json"},
    )
    assert status == 200
    assert payload["ok"] is True

    monkeypatch.setattr("app.outlook_feed._urlopen", lambda *a, **k: _Resp(b""))
    status, payload = _http_json("GET", "https://graph.microsoft.com/v1.0/me")
    assert payload == {}

    monkeypatch.setattr("app.outlook_feed._urlopen", lambda *a, **k: _Resp(b"not-json"))
    with pytest.raises(RuntimeError, match="non-JSON"):
        _http_json("GET", "https://graph.microsoft.com/v1.0/me")

    class _401(_Resp):
        status = 401
        def read(self):
            return json.dumps({"error": "invalid_token"}).encode()

    monkeypatch.setattr("app.outlook_feed._urlopen", lambda *a, **k: _401())
    with pytest.raises(RuntimeError, match="invalid_token"):
        _http_json("GET", "https://graph.microsoft.com/v1.0/me")

    class _500(_Resp):
        status = 500
    monkeypatch.setattr("app.outlook_feed._urlopen", lambda *a, **k: _500(b"oops"))
    with pytest.raises(OSError):
        _http_json("GET", "https://graph.microsoft.com/v1.0/me")

    def _http_err(*_a, **_k):
        raise urllib.error.HTTPError(
            "https://login.microsoftonline.com/x/oauth2/v2.0/token",
            401, "Unauthorized", hdrs=None,
            fp=io.BytesIO(json.dumps({"error": "invalid_token"}).encode()),
        )
    monkeypatch.setattr("app.outlook_feed._urlopen", _http_err)
    with pytest.raises(RuntimeError, match="invalid_token"):
        _http_json("POST", "https://login.microsoftonline.com/x/oauth2/v2.0/token")

    def _http_500(*_a, **_k):
        raise urllib.error.HTTPError(
            "https://graph.microsoft.com/v1.0/users/x/messages",
            503, "Unavailable", hdrs=None, fp=io.BytesIO(b"down"),
        )
    monkeypatch.setattr("app.outlook_feed._urlopen", _http_500)
    with pytest.raises(OSError):
        _http_json("GET", "https://graph.microsoft.com/v1.0/users/x/messages")

    class _BadFp:
        def read(self):
            raise OSError("closed")
        def close(self):
            return None
    def _http_badfp(*_a, **_k):
        raise urllib.error.HTTPError(
            "https://graph.microsoft.com/v1.0/users/x/messages",
            400, "Bad", hdrs=None, fp=_BadFp(),
        )
    monkeypatch.setattr("app.outlook_feed._urlopen", _http_badfp)
    with pytest.raises(RuntimeError):
        _http_json("GET", "https://graph.microsoft.com/v1.0/users/x/messages")

    def _urlerr(*_a, **_k):
        raise urllib.error.URLError("dns")
    monkeypatch.setattr("app.outlook_feed._urlopen", _urlerr)
    with pytest.raises(OSError):
        _http_json("GET", "https://graph.microsoft.com/v1.0/users/x/messages")

    def _timeout(*_a, **_k):
        raise TimeoutError("slow")
    monkeypatch.setattr("app.outlook_feed._urlopen", _timeout)
    with pytest.raises(OSError, match="timed out"):
        _http_json("GET", "https://graph.microsoft.com/v1.0/users/x/messages")

    with pytest.raises(RuntimeError):
        _call_http(lambda *_a, **_k: (400, {"e": TD_SECRET}), "GET", "https://x", secret=TD_SECRET)
    with pytest.raises(OSError):
        _call_http(lambda *_a, **_k: (500, {"e": "x"}), "GET", "https://x")
    assert _call_http(lambda *_a, **_k: {"access_token": "t"}, "POST", "https://x")["access_token"] == "t"


def test_connect_host_prefers_ipv4_then_falls_back(monkeypatch):
    import socket as sockmod
    from app import outlook_feed as of

    class Sock:
        def __init__(self, *a, **k):
            self.sa = None
        def settimeout(self, t):
            pass
        def connect(self, sa):
            if str(sa[0]).startswith("2603"):
                raise OSError(101, "Network unreachable")
            self.sa = sa
        def close(self):
            raise OSError("already closed")

    families = []

    def gi(host, port, family, *a, **k):
        families.append(family)
        if family == sockmod.AF_INET:
            return [(sockmod.AF_INET, sockmod.SOCK_STREAM, 6, "", ("20.1.1.1", 443))]
        if family == sockmod.AF_INET6:
            return [(sockmod.AF_INET6, sockmod.SOCK_STREAM, 6, "", ("2603::1", 443, 0, 0))]
        raise OSError("nope")

    monkeypatch.setattr(of.socket, "getaddrinfo", gi)
    monkeypatch.setattr(of.socket, "socket", lambda *a, **k: Sock())
    s = of._connect_host("login.microsoftonline.com", 443, 5)
    assert s.sa[0] == "20.1.1.1"
    assert families[0] == sockmod.AF_INET

    def gi_v4fail(host, port, family, *a, **k):
        if family == sockmod.AF_INET:
            return [(sockmod.AF_INET, sockmod.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]
        return [(sockmod.AF_INET6, sockmod.SOCK_STREAM, 6, "", ("2603::9", 443, 0, 0))]

    class SockV4Fail(Sock):
        def connect(self, sa):
            if str(sa[0]) == "1.1.1.1":
                raise OSError(101, "Network unreachable")
            self.sa = sa

    monkeypatch.setattr(of.socket, "getaddrinfo", gi_v4fail)
    monkeypatch.setattr(of.socket, "socket", lambda *a, **k: SockV4Fail())
    s_fb = of._connect_host("login.microsoftonline.com", 443, 5)
    assert "2603" in str(s_fb.sa[0])

    def gi6(host, port, family, *a, **k):
        if family == sockmod.AF_INET:
            raise OSError("no v4")
        return [(sockmod.AF_INET6, sockmod.SOCK_STREAM, 6, "", ("2603::1", 443, 0, 0))]

    class Sock6(Sock):
        def connect(self, sa):
            self.sa = sa

    monkeypatch.setattr(of.socket, "getaddrinfo", gi6)
    monkeypatch.setattr(of.socket, "socket", lambda *a, **k: Sock6())
    s6 = of._connect_host("login.microsoftonline.com", 443, 5)
    assert "2603" in str(s6.sa[0])

    def gi_fail(*_a, **_k):
        raise OSError("dns")

    monkeypatch.setattr(of.socket, "getaddrinfo", gi_fail)
    with pytest.raises(OSError):
        of._connect_host("login.microsoftonline.com", 443, 5)

    def gi_empty(host, port, family, *a, **k):
        return []

    monkeypatch.setattr(of.socket, "getaddrinfo", gi_empty)
    with pytest.raises(OSError):
        of._connect_host("x", 443, 5)

    class _Ctx:
        def wrap_socket(self, sock, server_hostname=None):
            return sock

    conn = of._HTTPSConnection("graph.microsoft.com", 443, timeout=5, context=_Ctx())
    monkeypatch.setattr(of, "_connect_host", lambda *a, **k: Sock())
    conn.connect()
    assert conn.sock is not None
    conn2 = of._HTTPSConnection("graph.microsoft.com", timeout=None, context=_Ctx())
    conn2.connect()
    assert conn2.sock is not None

    class _Opener:
        def open(self, req, timeout=None):
            class _R:
                status = 200
                def read(self):
                    return b"{}"
                def __enter__(self):
                    return self
                def __exit__(self, *a):
                    return False
            return _R()
    monkeypatch.setattr(of.urllib.request, "build_opener", lambda *_a, **_k: _Opener())
    with of._urlopen(of.urllib.request.Request("https://graph.microsoft.com/v1.0/me"), timeout=5) as resp:
        assert resp.status == 200
    h = of._HTTPSHandler()
    h.do_open = lambda conn_cls, req: (conn_cls, req)
    opened = h.https_open(of.urllib.request.Request("https://graph.microsoft.com/v1.0/me"))
    assert opened[0] is of._HTTPSConnection


@_needs_db
def test_old_message_outside_lookback_skipped(monkeypatch, _admin):
    from app import outlook_feed as of
    from app.db import get_conn
    old = datetime.now(timezone.utc) - timedelta(days=30)
    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "lookback_days": 7,
        "client_secret": TD_SECRET, "tenant_id": TD_TENANT, "client_id": TD_CLIENT,
    })
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET last_received_at = NULL, lookback_days = 7 WHERE id = 1")
        conn.commit()
    monkeypatch.setattr(of, "_http_json", _FakeGraph([
        _graph_msg(message_id="<old@outlook.test>", received=old, body="ancient"),
        {
            "internetMessageId": "<undated@outlook.test>",
            "subject": "No date",
            "body": {"contentType": "text", "content": "undated body"},
            "from": {"emailAddress": {"address": "a@b.c"}},
        },
    ]))
    r = client.post("/api/outlook-feed/fetch")
    assert r.status_code == 200
    assert r.json()["imported"] == 1


def test_outlook_feed_source_never_deletes_mail():
    import re
    from pathlib import Path
    src = Path(__file__).resolve().parents[1].joinpath("app", "outlook_feed.py").read_text(encoding="utf8")
    methods = re.findall(r'_call_http\(\s*\w+\s*,\s*"(\w+)"', src)
    assert "GET" in methods
    assert "DELETE" not in methods
    assert "PATCH" not in methods
    assert "PUT" not in methods
