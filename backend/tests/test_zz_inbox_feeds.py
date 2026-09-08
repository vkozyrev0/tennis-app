"""Inbox Get mails: date-window fetch of enabled Gmail + Outlook feeds."""
from __future__ import annotations

import uuid
import urllib.parse
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.inbox_feeds import as_window, gmail_ready, outlook_ready
from app.main import app

client = TestClient(app)

_needs_db = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


@pytest.fixture
def _admin():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def test_as_window_coerces_dates_and_strings():
    start, end = as_window(date(2026, 9, 1), date(2026, 9, 8))
    assert start.day == 1 and start.hour == 0
    assert end.day == 8 and end.hour == 23
    s2, e2 = as_window("2026-09-01", "2026-09-08T12:00:00Z")
    assert s2.tzinfo is not None
    assert e2.hour == 12
    naive, _ = as_window(datetime(2026, 9, 1, 8, 0, 0), None)
    assert naive.tzinfo is not None
    aware, _ = as_window(datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc), None)
    assert aware.tzinfo is not None
    noz, _ = as_window("2026-09-08T12:00:00", None)
    assert noz.hour == 12 and noz.tzinfo is not None
    assert as_window(None, "") == (None, None)
    assert as_window("", None) == (None, None)
    blank, _ = as_window("   ", None)
    assert blank is None


@_needs_db
def test_get_all_widens_since_to_event_start(monkeypatch, _admin):
    from app import gmail_feed as gf
    from app import outlook_feed as of

    seen = {}
    t = client.post("/api/tournaments", json={
        "name": "GetAll " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-01-15", "play_end_date": "2026-01-18",
    }).json()
    monkeypatch.setattr(gf, "load_feed", lambda cur: {
        "enabled": True, "gmail_address": "a@b.com", "secret_enc": "x",
    })
    monkeypatch.setattr(of, "load_feed", lambda cur: {
        "enabled": False, "mailbox": "", "secret_enc": None,
    })

    def gfetch(cur, **kw):
        seen["since"] = kw.get("since")
        return {"imported": 0, "duplicates": 0}

    monkeypatch.setattr(gf, "fetch_latest", gfetch)
    r = client.post(
        f"/api/inbox-feeds/fetch?since=2026-09-01&until=2026-09-08"
        f"&tournament_id={t['id']}&get_all=true"
    )
    assert r.status_code == 200, r.text
    assert seen["since"] is not None
    assert seen["since"].date().isoformat() == "2026-01-15"


def test_fetch_inbox_mails_forwards_tournament_id(monkeypatch):
    from app import gmail_feed as gf
    from app import inbox_feeds as inf
    from app import outlook_feed as of

    seen = {}
    monkeypatch.setattr(gf, "load_feed", lambda cur: {
        "enabled": True, "gmail_address": "a@b.com", "secret_enc": "x",
    })
    monkeypatch.setattr(of, "load_feed", lambda cur: {
        "enabled": True, "mailbox": "td@x.com", "secret_enc": "x",
    })

    def gfetch(cur, **kw):
        seen["g"] = kw.get("tournament_id")
        return {"imported": 1, "duplicates": 0}

    def ofetch(cur, **kw):
        seen["o"] = kw.get("tournament_id")
        return {"imported": 2, "duplicates": 3}

    monkeypatch.setattr(gf, "fetch_latest", gfetch)
    monkeypatch.setattr(of, "fetch_latest", ofetch)
    out = inf.fetch_inbox_mails(
        None, since="2026-09-01", until="2026-09-08", tournament_id=42,
    )
    assert seen == {"g": 42, "o": 42}
    assert out["imported"] == 3
    assert out["duplicates"] == 3


def test_ready_helpers_require_enabled_and_credentials():
    assert gmail_ready(None) is False
    assert gmail_ready({"enabled": True, "gmail_address": "a@b.com", "secret_enc": None}) is False
    assert gmail_ready({"enabled": True, "gmail_address": "a@b.com", "secret_enc": "x"}) is True
    assert gmail_ready({"enabled": False, "gmail_address": "a@b.com", "secret_enc": "x"}) is False
    assert outlook_ready({"enabled": True, "mailbox": "TD@x.com", "secret_enc": "x"}) is True
    assert outlook_ready({"enabled": True, "mailbox": "", "secret_enc": "x"}) is False
    assert outlook_ready({"enabled": False, "mailbox": "TD@x.com", "secret_enc": "x"}) is False


@_needs_db
def test_get_mails_skips_disabled_gmail_runs_outlook(monkeypatch, _admin):
    from app import gmail_feed as gf
    from app import outlook_feed as of
    from app.db import get_conn
    from tests.test_zz_gmail_feed import _FakeImap, _rfc822
    from tests.test_zz_outlook_feed import TD_CLIENT, TD_MAILBOX, TD_SECRET, TD_TENANT, _FakeGraph, _graph_msg

    imap_calls = []

    class _TrackImap(_FakeImap):
        def uid(self, cmd, *args):
            imap_calls.append((cmd, args))
            return super().uid(cmd, *args)

    start = date.today() + timedelta(days=50)
    t = client.post("/api/tournaments", json={
        "name": "Feeds " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }).json()
    client.put("/api/gmail-feed", json={
        "enabled": False, "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop", "tournament_id": t["id"],
    })
    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT, "tournament_id": t["id"],
    })
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _TrackImap)
    msg = _graph_msg(
        message_id=f"<win-{uuid.uuid4().hex}@outlook.test>",
        subject="Window mail",
        received=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    fake = _FakeGraph([msg])
    monkeypatch.setattr(of, "_http_json", fake)
    since = (date.today() - timedelta(days=7)).isoformat()
    until = date.today().isoformat()
    r = client.post(f"/api/inbox-feeds/fetch?since={since}&until={until}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "gmail" in body["skipped"]
    assert body["gmail"] is None
    assert body["outlook"] is not None
    assert imap_calls == []
    assert fake.token_urls
    assert any("receivedDateTime" in u for u in fake.mail_urls)
    assert all("isRead+eq+false" not in u and "isRead%20eq%20false" not in u
               for u in fake.mail_urls)


@_needs_db
def test_get_mails_date_window_on_gmail_and_skips_duplicate(monkeypatch, _admin):
    from app import gmail_feed as gf
    from app.db import get_conn
    from tests.test_zz_gmail_feed import _FakeImap, _rfc822

    seen = {}

    class _WinImap(_FakeImap):
        def uid(self, cmd, *args):
            if cmd == "SEARCH":
                seen["search"] = args
                assert "SINCE" in args
                assert "BEFORE" in args
                assert "ALL" in args
                assert "UNSEEN" not in args
                return ("OK", [b"55"])
            return super().uid(cmd, *args)

    start = date.today() + timedelta(days=51)
    t = client.post("/api/tournaments", json={
        "name": "GWin " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }).json()
    client.put("/api/gmail-feed", json={
        "enabled": True, "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop", "tournament_id": t["id"],
    })
    client.put("/api/outlook-feed", json={"enabled": False, "mailbox": "TD@myadllc.com"})
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _WinImap)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 90 WHERE id = 1")
        conn.commit()
    since = (date.today() - timedelta(days=3)).isoformat()
    until = date.today().isoformat()
    r = client.post(f"/api/inbox-feeds/fetch?since={since}&until={until}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "outlook" in body["skipped"]
    assert body["gmail"] is not None
    assert "SINCE" in seen.get("search", ())
    listed = client.get(f"/api/emails?tournament_id={t['id']}").json()
    gmail_rows = [e for e in listed if e.get("ingest_source") == "gmail"]
    assert gmail_rows
    r2 = client.post(f"/api/inbox-feeds/fetch?since={since}&until={until}")
    assert r2.status_code == 200
    assert r2.json()["gmail"]["imported"] == 0
    assert r2.json()["gmail"]["duplicates"] >= 1


@_needs_db
def test_get_mails_skips_unset_outlook(monkeypatch, _admin):
    from app.db import get_conn
    client.put("/api/gmail-feed", json={"enabled": False})
    client.put("/api/outlook-feed", json={"enabled": True, "mailbox": "TD@myadllc.com"})
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE outlook_feed SET secret_enc = NULL, mailbox = '' WHERE id = 1")
        conn.commit()
    r = client.post("/api/inbox-feeds/fetch")
    assert r.status_code == 200, r.text
    assert "gmail" in r.json()["skipped"]
    assert "outlook" in r.json()["skipped"]
    assert r.json()["imported"] == 0
    client.put("/api/outlook-feed", json={"enabled": False, "mailbox": "TD@myadllc.com"})


@_needs_db
def test_outlook_date_window_keeps_in_range_only(monkeypatch, _admin):
    from app import outlook_feed as of
    from tests.test_zz_outlook_feed import TD_CLIENT, TD_MAILBOX, TD_SECRET, TD_TENANT, _FakeGraph, _graph_msg

    now = datetime.now(timezone.utc)
    msgs = [
        _graph_msg(message_id=f"<old-{uuid.uuid4().hex}@o.test>", subject="too old",
                   received=now - timedelta(days=10)),
        _graph_msg(message_id=f"<in-{uuid.uuid4().hex}@o.test>", subject="in window",
                   received=now - timedelta(hours=2)),
        _graph_msg(message_id=f"<fut-{uuid.uuid4().hex}@o.test>", subject="too new",
                   received=now + timedelta(days=2)),
        {"internetMessageId": f"<nd-{uuid.uuid4().hex}@o.test>", "subject": "no date",
         "body": {"contentType": "text", "content": "x"},
         "from": {"emailAddress": {"address": "a@b.c"}}},
    ]
    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT,
    })
    monkeypatch.setattr(of, "_http_json", _FakeGraph(msgs))
    since = (date.today() - timedelta(days=1)).isoformat()
    until = date.today().isoformat()
    r = client.post(f"/api/outlook-feed/fetch?since={since}&until={until}")
    assert r.status_code == 200, r.text
    # in-window + undated kept; old/future skipped. Undated may import.
    assert r.json()["fetched"] >= 1
    assert r.json()["fetched"] <= 2


@_needs_db
@_needs_db
def test_outlook_date_window_includes_read_and_follows_nextlink(monkeypatch, _admin):
    from app import outlook_feed as of
    from tests.test_zz_outlook_feed import TD_CLIENT, TD_MAILBOX, TD_SECRET, TD_TENANT, _FakeGraph, _graph_msg

    now = datetime.now(timezone.utc)
    page1 = _graph_msg(message_id=f"<p1-{uuid.uuid4().hex}@o.test>", subject="read page1",
                       received=now - timedelta(hours=3))
    page1["isRead"] = True
    page2 = _graph_msg(message_id=f"<p2-{uuid.uuid4().hex}@o.test>", subject="read page2",
                       received=now - timedelta(hours=2))
    page2["isRead"] = True

    class _Paged(_FakeGraph):
        def __call__(self, method, url, **kw):
            if "oauth2/v2.0/token" in url:
                return super().__call__(method, url, **kw)
            self.mail_urls.append(url)
            assert "isRead eq false" not in urllib.parse.unquote(url)
            if "skiptoken" in url:
                return 200, {"value": [page2]}
            return 200, {
                "value": [page1],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/x/messages?skiptoken=2",
            }

    client.put("/api/outlook-feed", json={
        "enabled": True, "mailbox": TD_MAILBOX, "client_secret": TD_SECRET,
        "tenant_id": TD_TENANT, "client_id": TD_CLIENT,
    })
    fake = _Paged([])
    monkeypatch.setattr(of, "_http_json", fake)
    since = (date.today() - timedelta(days=1)).isoformat()
    until = date.today().isoformat()
    r = client.post(f"/api/outlook-feed/fetch?since={since}&until={until}")
    assert r.status_code == 200, r.text
    assert r.json()["fetched"] == 2
    assert any("skiptoken" in u for u in fake.mail_urls)


def test_graph_nextlink_non_dict_stops():
    from app.outlook_feed import _graph_fetch
    from tests.test_zz_outlook_feed import TD_CLIENT, TD_MAILBOX, TD_TENANT, _FakeGraph, _graph_msg

    msg = _graph_msg(message_id="<p@o.test>", subject="p1",
                     received=datetime.now(timezone.utc))

    class _BadPage(_FakeGraph):
        def __call__(self, method, url, **kw):
            if "oauth2/v2.0/token" in url:
                return super().__call__(method, url, **kw)
            if "skiptoken" in url:
                return 200, "nope"
            return 200, {
                "value": [msg],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/x/messages?skiptoken=2",
            }

    row = {
        "mailbox": TD_MAILBOX, "tenant_id": TD_TENANT, "client_id": TD_CLIENT,
        "secret_enc": "x", "mail_query": None, "lookback_days": 7,
    }
    since = datetime.now(timezone.utc) - timedelta(days=1)
    until = datetime.now(timezone.utc)
    kept, _cur = _graph_fetch(row, http=_BadPage([]), since=since, until=until)
    assert len(kept) == 1


def test_graph_fetch_parses_string_cursor():
    from app.outlook_feed import _graph_fetch
    from tests.test_zz_outlook_feed import TD_CLIENT, TD_MAILBOX, TD_TENANT, _FakeGraph

    row = {
        "mailbox": TD_MAILBOX, "tenant_id": TD_TENANT, "client_id": TD_CLIENT,
        "secret_enc": "x", "mail_query": None,
        "last_received_at": "2026-09-01T00:00:00Z", "lookback_days": 7,
    }
    since = datetime(2026, 9, 7, tzinfo=timezone.utc)
    until = datetime(2026, 9, 8, tzinfo=timezone.utc)
    kept, cursor = _graph_fetch(row, http=_FakeGraph([]), since=since, until=until)
    assert kept == []
    assert cursor is not None


def test_inbox_feeds_fetch_errors(monkeypatch, _admin):
    from app.routers import inbox_feeds as ir
    monkeypatch.setattr(ir, "fetch_inbox_mails", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("nope")))
    r = client.post("/api/inbox-feeds/fetch")
    assert r.status_code == 400
    monkeypatch.setattr(ir, "fetch_inbox_mails", lambda *_a, **_k: (_ for _ in ()).throw(OSError("down")))
    r = client.post("/api/inbox-feeds/fetch")
    assert r.status_code == 502
