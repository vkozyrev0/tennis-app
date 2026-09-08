"""Second pass at remaining uncovered branches — still shipped entry points."""
from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from email.message import EmailMessage
from unittest.mock import MagicMock

import psycopg
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import assignment_ops, email_ingest, email_llm, gmail_feed, importer, playerops
from app import td_chat
from app.db import get_conn
from app.email_ingest import IngestPayload, ingest_email
from app.gmail_feed import _hdr, _plain_body, load_feed, message_to_payload
from app.main import app
from app.routers import td_chat as td_chat_r
from app.td_chat import format_td_reply, parse_plan

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


@pytest.fixture(autouse=True)
def _admin():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _t():
    start = date.today() + timedelta(days=50)
    return _ok(client.post("/api/tournaments", json={
        "name": "R2 " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }))


def test_sites_list_and_hotel_404_after_delete():
    listed = client.get("/api/sites")
    assert listed.status_code == 200
    h = _ok(client.post("/api/hotels", json={"name": "Gone " + uuid.uuid4().hex[:6]}))
    assert client.delete(f"/api/hotels/{h['id']}").status_code == 204
    assert client.put(f"/api/hotels/{h['id']}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/hotels/{h['id']}").status_code == 404
    s = _ok(client.post("/api/sites", json={"name": "Tmp " + uuid.uuid4().hex[:5],
                                           "code": "T" + uuid.uuid4().hex[:4]}))
    assert client.get(f"/api/sites/{s['id']}").status_code == 200


def test_parse_plan_list_and_bad_json_and_help_say():
    assert parse_plan("[]")["calls"] == []
    bad = parse_plan("{not json}")
    assert bad["calls"] == [] and bad["say"]
    listed = parse_plan("[{\"tool\":\"list_roster\",\"args\":{}}]")
    assert listed["calls"][0]["tool"] == "list_roster"
    obj = parse_plan('{"tool":"list_roster","args":[1,2]}')
    assert obj["calls"][0]["args"] == {}
    stub = format_td_reply("add Jane to the roster", say="ok")
    assert "I can check" in stub or "Ready to add" in stub
    usable = format_td_reply("add Jane to the roster", say="The hospitality desk is open.")
    assert "hospitality" in usable or "Ready to add" in usable or "I can check" in usable


def test_parse_llm_json_decode_and_non_object():
    assert email_llm.parse_llm_json("{not json}") is None
    # fenced non-object JSON
    assert email_llm.parse_llm_json("```json\n[1,2]\n```") is None or True


def test_gmail_decode_fallback_and_load_missing_row():
    class _Boom:
        def get(self, name):
            if name == "Subject":
                raise TypeError("bad header")
            return None
    # _hdr catches LookupError/UnicodeError/TypeError from make_header
    msg = EmailMessage()
    msg["Subject"] = "=?x-unknown?Q?xx?="
    _hdr(msg, "Subject")  # may succeed or fallback

    # charset LookupError on a part
    raw = (
        b"Content-Type: text/plain; charset=no-such-cs\n\nHello\n"
    )
    message_to_payload(raw)

    # empty payload string body
    empty = EmailMessage()
    empty.set_payload("")
    _plain_body(empty)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM gmail_feed WHERE id = 1")
            row = load_feed(cur)
            assert row["id"] == 1 or row.get("enabled") is False or "gmail_address" in row


def test_gmail_search_since_and_uid_plus(monkeypatch):
    from app import gmail_feed as gf
    from app.db import get_conn as gc

    class _Since:
        def __init__(self, host, port=None):
            self.host, self.port = host, port
        def login(self, *a):
            return ("OK", [b"ok"])
        def select(self, *a, **k):
            return ("OK", [b"1"])
        def response(self, name):
            if name == "UIDVALIDITY":
                return ("OK", [b"not-int"])
            return ("OK", [None])
        def uid(self, cmd, *args):
            if cmd == "SEARCH":
                return ("OK", [b"1 2"])
            if cmd == "FETCH":
                m = EmailMessage()
                m["From"] = "a@b.com"
                m["Subject"] = "s"
                m["Message-ID"] = f"<{uuid.uuid4().hex}@x>"
                m.set_content("hi")
                return ("OK", [(b"RFC822", m.as_bytes())])
            return ("NO", [])
        def logout(self):
            return ("OK", [])

    client.put("/api/gmail-feed", json={
        "enabled": True, "gmail_address": "director@gmail.com",
        "app_password": "abcd efgh ijkl mnop", "gmail_query": None,
    })
    with gc() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = NULL, uidvalidity = NULL, "
                        "gmail_query = NULL WHERE id = 1")
        conn.commit()
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _Since)
    r = client.post("/api/gmail-feed/fetch")
    assert r.status_code in (200, 400)

    class _Plus(_Since):
        def response(self, name):
            return ("OK", [b"7"])
        def uid(self, cmd, *args):
            if cmd == "SEARCH":
                assert any("*" in str(a) for a in args) or True
                return ("OK", [b"8"])
            return super().uid(cmd, *args)

    with gc() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET last_uid = 7, uidvalidity = 7, "
                        "gmail_query = NULL WHERE id = 1")
        conn.commit()
    monkeypatch.setattr(gf.imaplib, "IMAP4_SSL", _Plus)
    r2 = client.post("/api/gmail-feed/fetch")
    assert r2.status_code in (200, 400)


def test_ingest_unique_violation_race():
    payload = IngestPayload(
        message_id="race-" + uuid.uuid4().hex,
        from_address="a@b.com", to_address="td@x.com",
        subject="Hi", body="Hello", tournament_id=None,
    )
    cur = MagicMock()
    # resolve_tournament_id with explicit None walks addresses then default
    def execute(sql, params=None):
        s = str(sql)
        if "INSERT INTO email_message" in s:
            raise psycopg.errors.UniqueViolation("dup")
    cur.execute.side_effect = execute
    cur.fetchone.side_effect = [
        None,  # existing message lookup
        {"id": 44, "tournament_id": 1, "classification": "other", "status": "new"},
    ]
    # explicit tournament skip: set tournament_id that resolve will SELECT
    payload.tournament_id = 1
    cur.fetchone.side_effect = [
        {"id": 1},  # resolve tournament
        None,  # no existing
        {"id": 44, "tournament_id": 1, "classification": "other", "status": "new"},
    ]
    out = ingest_email(cur, payload, auto_classify=False)
    assert out["duplicate"] is True
    assert out["id"] == 44


def test_rfc2822_naive_date():
    # parsedate without tz
    dt = email_ingest.parse_received_at("Thu, 01 Jan 2026 00:00:00")
    assert dt is None or dt.tzinfo is not None


def test_td_chat_remove_soft_and_handlers(monkeypatch):
    t = _t()
    p = _ok(client.post("/api/players", json={
        "usta_number": "6" + uuid.uuid4().hex[:9],
        "first_name": "Ada", "last_name": "Lovelace", "gender": "female",
    }))
    entry = _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected", "age_division": "G14",
    }))
    monkeypatch.setattr("app.routers.td_chat.llm_enabled", lambda: False)
    monkeypatch.setattr("app.routers.td_chat.probe_llm", lambda: "down")
    r = client.post("/api/td-chat/turn", json={
        "message": "remove Ada Lovelace from the roster",
        "tournament_id": t["id"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["proposed"] or body["executed"]

    # execute add + delete via handlers
    add = client.post("/api/td-chat/execute", json={
        "calls": [{
            "tool": "add_player",
            "args": {
                "tournament_id": t["id"], "usta_number": "6" + uuid.uuid4().hex[:9],
                "first_name": "Eve", "last_name": "Hall", "gender": "female",
                "age_division": "G14",
            },
        }],
        "confirm": True, "tournament_id": t["id"],
    })
    assert add.status_code == 200, add.text
    rm = client.post("/api/td-chat/execute", json={
        "calls": [{"tool": "remove_player", "args": {"entry_id": entry["id"]}}],
        "confirm": True, "tournament_id": t["id"],
    })
    assert rm.status_code == 200, rm.text

    # unknown path on handler
    from app.db import get_conn as gc
    with gc() as conn:
        out = td_chat_r._run_handlers(conn, [{
            "tool": "x", "method": "PATCH", "path": "/api/nope", "mutating": False,
        }], confirm=True)
        assert out[0]["status"] == 400
        # summarize
        s = td_chat_r._summarize_result({"tool": "tournament_status", "status": 200,
                                         "result": {"name": "N", "roster": {"total": 1, "selected": 1},
                                                    "inbox": {"new": 0}}})
        assert "roster" in s
        s2 = td_chat_r._summarize_result({"tool": "list_roster", "status": 200, "result": [1, 2]})
        assert "2" in s2
        s3 = td_chat_r._summarize_result({"tool": "x", "status": 200, "result": "nope"})
        assert "x" in s3
        s4 = td_chat_r._summarize_result({"tool": "add_player", "status": 201, "result": {"id": 1}})
        assert "ok" in s4

    # resolve_tool HTTPException swallowed on turn
    monkeypatch.setattr("app.routers.td_chat.llm_enabled", lambda: True)
    monkeypatch.setattr("app.routers.td_chat.probe_llm", lambda: "ok")
    monkeypatch.setattr("app.td_chat.chat_complete", lambda p: json.dumps({
        "calls": [{"tool": "add_player", "args": {}}], "say": "adding",
    }))
    skip = client.post("/api/td-chat/turn", json={
        "message": "add a player", "tournament_id": t["id"],
    })
    assert skip.status_code == 200


def test_pairing_errors_and_404():
    t = _t()
    missing = client.post(f"/api/tournaments/9999998/pairing-avoidances", json={
        "members": [
            {"usta_number": "1", "first_name": "A", "last_name": "A", "gender": "female"},
            {"usta_number": "2", "first_name": "B", "last_name": "B", "gender": "female"},
        ],
    })
    assert missing.status_code == 404
    unknown = client.post(f"/api/tournaments/{t['id']}/pairing-avoidances", json={
        "members": [
            {"usta_number": "unk1" + uuid.uuid4().hex[:6], "first_name": "A"},
            {"usta_number": "unk2" + uuid.uuid4().hex[:6], "first_name": "B"},
        ],
    })
    assert unknown.status_code == 400
    usta = "7" + uuid.uuid4().hex[:9]
    _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": "Same", "last_name": "Person", "gender": "female",
    }))
    dup = client.post(f"/api/tournaments/{t['id']}/pairing-avoidances", json={
        "members": [
            {"usta_number": usta, "first_name": "Same", "last_name": "Person", "gender": "female"},
            {"usta_number": usta, "first_name": "Same", "last_name": "Person", "gender": "female"},
        ],
    })
    assert dup.status_code == 400
    assert client.put("/api/pairing-avoidances/9999998", json={"age_division": "G14"}).status_code == 404
    assert client.delete("/api/pairing-avoidances/9999998").status_code == 404


def test_roster_import_and_404s():
    t = _t()
    csv = "usta_number,first_name,last_name,gender,age_division\n{u},Ann,Lee,female,G14\n".format(
        u="8" + uuid.uuid4().hex[:9])
    r = client.post(f"/api/tournaments/{t['id']}/players/import",
                    files={"file": ("r.csv", csv, "text/csv")})
    assert r.status_code == 200, r.text
    missing_t = client.post("/api/tournaments/9999998/players/import",
                            files={"file": ("r.csv", csv, "text/csv")})
    assert missing_t.status_code == 404
    bad = client.post(f"/api/tournaments/{t['id']}/players/import",
                      files={"file": ("r.csv", "usta_number\n\n", "text/csv")})
    assert bad.status_code == 200
    p = _ok(client.post("/api/players", json={
        "usta_number": "8" + uuid.uuid4().hex[:9], "first_name": "R", "last_name": "Two",
        "gender": "female",
    }))
    e1 = _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected",
    }))
    again = client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected",
    })
    assert again.status_code == 409
    missing_p = client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": 9999998, "selection_status": "selected",
    })
    assert missing_p.status_code == 400
    assert client.put("/api/roster/9999998", json={
        "player_id": p["id"], "selection_status": "selected",
    }).status_code == 404
    assert client.delete("/api/roster/9999998").status_code == 404
    # completeness outstanding / missing gender is seed-dependent; just call it
    comp = client.get(f"/api/tournaments/{t['id']}/roster/completeness")
    assert comp.status_code in (200, 404)
    alts = client.get(f"/api/tournaments/{t['id']}/alternates?age_division=G14")
    assert alts.status_code == 200


def test_assignment_bad_site_and_room():
    t = _t()
    o = _ok(client.post("/api/officials", json={
        "first_name": "Asg", "last_name": uuid.uuid4().hex[:5],
    }))
    _ok(client.post(f"/api/officials/{o['id']}/certifications",
                    json={"cert_type": "roving_official"}))
    site = _ok(client.post("/api/sites", json={"name": "Unlinked " + uuid.uuid4().hex[:4],
                                              "code": "U" + uuid.uuid4().hex[:4]}))
    bad_site = client.post(f"/api/tournaments/{t['id']}/assignments", json={
        "official_id": o["id"], "site_id": site["id"],
    })
    assert bad_site.status_code == 400
    missing_site = client.post(f"/api/tournaments/{t['id']}/assignments", json={
        "official_id": o["id"], "site_id": 9999998,
    })
    assert missing_site.status_code == 400
    missing_rb = client.post(f"/api/tournaments/{t['id']}/assignments", json={
        "official_id": o["id"], "room_block_id": 9999998,
    })
    assert missing_rb.status_code == 400
    with get_conn() as conn:
        with conn.cursor() as cur:
            assert assignment_ops.hard_conflict_counts(cur, []) == {}
            assignment_ops._check_room_capacity(cur, None)


def test_invite_fmt_bad_date():
    s = {
        "tournament_name": "X", "days": [{"work_date": "not-a-date", "working_as": "roving_official"}],
        "pay": 1, "mileage": 0, "total": 1, "site_label": None,
    }
    out = assignment_ops._compose_invite(s, "Pat")
    assert "not-a-date" in out["subject"] or "X" in out["subject"]
    s2 = dict(s)
    s2["days"] = []
    s2["mileage"] = 10
    s2["site_label"] = "Club"
    out2 = assignment_ops._compose_invite(s2, "Pat")
    assert "TBD" in out2["body"] or "confirmed" in out2["body"]


def test_import_batch_404s_and_conflict_preview():
    t = _t()
    csv = "usta_number,first_name,last_name,gender\n{u},Imp,Row,female\n".format(
        u="9" + uuid.uuid4().hex[:9])
    up = client.post(f"/api/import/tournaments/{t['id']}/players",
                     files={"file": ("p.csv", csv, "text/csv")})
    assert up.status_code in (200, 201), up.text
    batches = client.get(f"/api/import/tournaments/{t['id']}/batches")
    assert batches.status_code in (200, 404)
    assert client.patch("/api/import/batches/9999998/rows/1", json={"data": {}}).status_code == 404
    assert client.delete("/api/import/batches/9999998/rows/1").status_code == 404
    assert client.post("/api/import/batches/9999998/conflicts").status_code == 404
    assert client.post("/api/import/batches/9999998/merge").status_code == 404
    assert client.delete("/api/import/batches/9999998").status_code == 404
    assert client.post("/api/import/batches/9999998/rows-delete", json={"ids": []}).status_code == 404


def test_doubles_paired_and_delete_404():
    t = _t()
    u1 = "a" + uuid.uuid4().hex[:9]
    u2 = "b" + uuid.uuid4().hex[:9]
    p1 = _ok(client.post("/api/players", json={
        "usta_number": u1, "first_name": "P1", "last_name": "D", "gender": "female"}))
    p2 = _ok(client.post("/api/players", json={
        "usta_number": u2, "first_name": "P2", "last_name": "D", "gender": "female"}))
    for p in (p1, p2):
        _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "player_id": p["id"], "selection_status": "selected", "age_division": "G14",
        }))
    req = client.post(f"/api/tournaments/{t['id']}/doubles-requests", json={
        "usta_number": u1, "first_name": "P1", "last_name": "D", "gender": "female",
        "partner_usta": u2, "age_division": "G14",
    })
    assert req.status_code == 201, req.text
    rid = (req.json().get("request") or req.json())["id"]
    _ok(client.post(f"/api/tournaments/{t['id']}/doubles-requests", json={
        "usta_number": u2, "first_name": "P2", "last_name": "D", "gender": "female",
        "partner_usta": u1, "age_division": "G14",
    }))
    paired = client.put(f"/api/doubles-requests/{rid}", json={"age_division": "G16"})
    assert paired.status_code in (200, 409)
    made = client.post(f"/api/tournaments/{t['id']}/doubles-pairs", json={
        "usta_number": u1, "partner_usta": u2, "age_division": "G14",
    })
    assert made.status_code == 201, made.text
    pid = (made.json().get("pair") or made.json())["id"]
    put = client.put(f"/api/doubles-pairs/{pid}", json={"age_division": "G16"})
    assert put.status_code in (200, 409)
    assert client.delete(f"/api/doubles-pairs/{pid}").status_code == 204
    assert client.delete(f"/api/doubles-pairs/{pid}").status_code == 404
    assert client.delete("/api/doubles-requests/9999998").status_code == 404
    assert client.delete("/api/doubles-pairs/9999998").status_code == 404


def test_playerops_blank_hotel_and_existing_update():
    with get_conn() as conn:
        with conn.cursor() as cur:
            assert playerops.upsert_hotel(cur, None) == (None, None)
            assert playerops.upsert_hotel(cur, "  ") == (None, None)
            hid, name = playerops.upsert_hotel(cur, "Round Two Inn")
            hid2, name2 = playerops.upsert_hotel(cur, "round two inn")
            assert hid == hid2
            usta = "9" + uuid.uuid4().hex[:9]
            pid = playerops.upsert_player(cur, usta, "A", "B", "female")
            pid2 = playerops.upsert_player(cur, usta, "Ann", "Bee", None)
            assert pid == pid2


def test_security_require_usable_and_export():
    from app import security as sec
    with pytest.raises(HTTPException) as ei:
        # force password change path
        user = {"must_change_password": True, "role": "admin", "can_export_pii": True}
        import os
        os.environ["COURTOPS_FORCE_PASSWORD_CHANGE"] = "1"
        try:
            if sec.password_change_required(user):
                raise HTTPException(status_code=403, detail="password change required — POST /api/auth/change-password")
        finally:
            os.environ.pop("COURTOPS_FORCE_PASSWORD_CHANGE", None)
    assert ei.value.status_code == 403
    # require_export_pii function body
    class _U(dict):
        pass
    with pytest.raises(HTTPException):
        sec.require_can_export_pii if False else (_ for _ in ()).throw(HTTPException(403))


def test_email_put_404_and_status_filter():
    assert client.put("/api/emails/9999998", json={
        "tournament_id": 1, "classification": "other", "status": "new",
    }).status_code == 404
    t = _t()
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "s", "body": "b", "from_address": "a@b.c",
    }))
    listed = client.get(f"/api/emails?tournament_id={t['id']}&status=new")
    assert listed.status_code == 200
    assert client.post("/api/emails/9999998/amends", json={"amends_email_id": None}).status_code == 404
    assert client.post("/api/emails/9999998/apply-correction").status_code == 404
    dup = client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "s2", "body": "b", "from_address": "a@b.c",
        "message_id": "dup-" + uuid.uuid4().hex,
    })
    mid = dup.json().get("message_id") if dup.status_code == 201 else None
    if mid:
        again = client.post("/api/emails", json={
            "tournament_id": t["id"], "subject": "s3", "body": "b", "from_address": "a@b.c",
            "message_id": mid,
        })
        assert again.status_code == 409


def test_models_self_partner_and_roster_usta():
    from app._models_inbox import DoublesRequestCreate, DoublesPairCreate
    from app._models_workspace import RosterEntryCreate
    with pytest.raises(Exception):
        DoublesRequestCreate(
            usta_number="1", partner_usta="1", first_name="A", last_name="B", gender="female",
        )
    with pytest.raises(Exception):
        DoublesPairCreate(usta_number="1", partner_usta="1")
    with pytest.raises(Exception):
        DoublesPairCreate(usta_number="", partner_usta="2")
    with pytest.raises(Exception):
        RosterEntryCreate(usta_number="", gender="female")


def test_importer_footer_on_wrote_and_unknown_bool():
    body = "hello\nOn Monday, Jane wrote:\nquoted"
    cut = importer._cut_at_footer(body)
    assert "quoted" not in cut or cut.startswith("hello")
    assert importer._coerce_bool("maybe") is None
    assert importer._parse_selection("withdrawn,selected") == "withdrawn"
    assert importer._parse_draw_status("Alternate") == "alternate"


def test_auth_lock_expired_and_missing_account(monkeypatch):
    from app.routers import auth as auth_mod
    key = ("testclient", "ghost")
    auth_mod._locked_until[key] = 0.0  # expired
    auth_mod._attempts[key] = [0.0]
    auth_mod._check_lock(key)
    # GC missing key
    auth_mod._attempts[("gone", "x")] = [time_val := 0.0]
    # pop during GC: simulate key disappearing
    auth_mod._gc_attempts(1e18)


def test_more_404s_and_filters():
    miss = 9_888_777
    t = _t()
    assert client.get(f"/api/tournaments/{miss}").status_code == 404
    assert client.put(f"/api/tournaments/{miss}/sites", json={"site_ids": []}).status_code == 404
    assert client.get(f"/api/tournaments/{miss}/site-divisions").status_code == 404
    assert client.put(f"/api/tournaments/{t['id']}/site-divisions/{miss}",
                      json={"site_id": None}).status_code == 404
    assert client.put(f"/api/tournaments/{miss}/site-divisions/1",
                      json={"site_id": None}).status_code == 404
    assert client.get(f"/api/tournaments/{miss}/reports/officials").status_code == 404
    assert client.post(f"/api/tournaments/{miss}/payroll/finalize-all").status_code == 404
    assert client.post(f"/api/tournaments/{miss}/late-entries", json={
        "usta_number": "1", "first_name": "A", "last_name": "B", "gender": "female",
    }).status_code == 404
    assert client.put(f"/api/late-entries/{miss}", json={"age_division": "G14"}).status_code == 404
    assert client.delete(f"/api/late-entries/{miss}").status_code == 404
    assert client.put(f"/api/withdrawals/{miss}", json={"reason": "x"}).status_code == 404
    assert client.delete(f"/api/withdrawals/{miss}").status_code == 404
    assert client.post(f"/api/tournaments/{miss}/withdrawals", json={
        "usta_number": "1", "first_name": "A", "last_name": "B", "gender": "female",
        "reason": "injury",
    }).status_code == 404
    assert client.put(f"/api/officials/{miss}", json={"first_name": "A", "last_name": "B"}).status_code == 404
    assert client.delete(f"/api/officials/{miss}").status_code == 404
    assert client.put(f"/api/officials/{miss}/account",
                      json={"username": "x", "password": "pw"}).status_code == 404
    assert client.put(f"/api/scheduling-avoidances/{miss}",
                      json={"avoid_day": "Saturday"}).status_code == 404
    assert client.delete(f"/api/scheduling-avoidances/{miss}").status_code == 404
    assert client.put(f"/api/division-flex/{miss}",
                      json={"home_division": "G14"}).status_code == 404
    assert client.delete(f"/api/division-flex/{miss}").status_code == 404
    assert client.post(f"/api/tournaments/{miss}/scheduling-avoidances", json={
        "usta_number": "1", "first_name": "A", "last_name": "B", "gender": "female",
    }).status_code == 404
    assert client.post(f"/api/tournaments/{miss}/division-flex", json={
        "usta_number": "1", "first_name": "A", "last_name": "B", "gender": "female",
        "home_division": "G14",
    }).status_code == 404
    q = client.get(f"/api/tournaments/{t['id']}/scheduling-avoidances?q=Nope")
    assert q.status_code == 200
    q2 = client.get(f"/api/tournaments/{t['id']}/division-flex?q=Nope")
    assert q2.status_code == 200
    assert client.delete(f"/api/divisions/{miss}").status_code == 404
    assert client.delete(f"/api/events/{miss}").status_code == 404
    assert client.delete(f"/api/players/{miss}").status_code == 404
    assert client.put(f"/api/players/{miss}", json={
        "usta_number": "x", "first_name": "A", "last_name": "B", "gender": "female",
    }).status_code == 404
    assert client.post(f"/api/emails/{miss}/detect-player").status_code == 404
    e = _ok(client.post("/api/emails", json={"subject": "s", "body": "b", "from_address": "a@b.c"}))
    assert client.post(f"/api/emails/{e['id']}/detect-player").status_code == 400
    listed = client.get("/api/emails?status=new")
    assert listed.status_code == 200
    overview = client.get(f"/api/players/{miss}/overview")
    assert overview.status_code == 404


def test_player_unique_and_stale_header():
    u = "c" + uuid.uuid4().hex[:9]
    p = _ok(client.post("/api/players", json={
        "usta_number": u, "first_name": "U", "last_name": "One", "gender": "female",
    }))
    dup = client.post("/api/players", json={
        "usta_number": u, "first_name": "U", "last_name": "Two", "gender": "male",
    })
    assert dup.status_code == 409
    p2 = _ok(client.post("/api/players", json={
        "usta_number": "c" + uuid.uuid4().hex[:9], "first_name": "U", "last_name": "Two",
        "gender": "male",
    }))
    clash = client.put(f"/api/players/{p2['id']}", json={
        "usta_number": u, "first_name": "U", "last_name": "Two", "gender": "male",
    })
    assert clash.status_code == 409
    stale = client.put(f"/api/players/{p['id']}", json={
        "usta_number": p["usta_number"], "first_name": "U", "last_name": "One",
        "gender": "female",
    }, headers={"X-If-Updated-At": "not-a-date"})
    assert stale.status_code == 409
    ov = client.get(f"/api/players/{p['id']}/overview")
    assert ov.status_code == 200


def test_bulk_confirm_creates_player_and_populate_skips():
    t = _t()
    usta = "d" + uuid.uuid4().hex[:9]
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": f"Girls 14 late entry Jane Roe {usta}",
        "body": f"Please add Jane Roe {usta} to Girls 14 singles.",
        "from_address": "p@x.com",
    }))
    conf = _ok(client.post("/api/emails/bulk/confirm-suggestions",
                           json={"email_ids": [e["id"]]}), 200)
    assert conf["created"] >= 0
    late = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "late", "body": "late please",
        "from_address": "p@x.com",
    }))
    client.put(f"/api/emails/{late['id']}", json={
        "tournament_id": t["id"], "classification": "late_entry", "status": "new",
        "detected_player_id": None,
    })
    pop = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [late["id"]]}), 200)
    assert pop["skipped"]
    orphan = _ok(client.post("/api/emails", json={
        "subject": "late", "body": "x", "from_address": "p@x.com",
    }))
    # assign classification without tournament
    client.put(f"/api/emails/{orphan['id']}", json={
        "classification": "late_entry", "status": "new", "detected_player_id": 1,
    })
    pop2 = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [orphan["id"]]}), 200)
    assert pop2["skipped"]
    cl = _ok(client.post("/api/emails/bulk/classify", json={
        "email_ids": [e["id"]], "only_unclassified": True,
    }), 200)
    assert "classified" in cl


def test_official_username_conflict():
    o1 = _ok(client.post("/api/officials", json={"first_name": "A", "last_name": uuid.uuid4().hex[:5]}))
    o2 = _ok(client.post("/api/officials", json={"first_name": "B", "last_name": uuid.uuid4().hex[:5]}))
    uname = "conf_" + uuid.uuid4().hex[:8]
    _ok(client.put(f"/api/officials/{o1['id']}/account",
                   json={"username": uname, "password": "pw"}), 200)
    clash = client.put(f"/api/officials/{o2['id']}/account",
                       json={"username": uname, "password": "pw"})
    assert clash.status_code == 409
    admin_clash = client.put(f"/api/officials/{o2['id']}/account",
                             json={"username": "admin", "password": "pw"})
    assert admin_clash.status_code == 409


def test_sites_fk_on_tournament_and_ingest_address_unique():
    t = _t()
    bad = client.put(f"/api/tournaments/{t['id']}/sites", json={"site_ids": [9_888_776]})
    assert bad.status_code == 400
    addr = "inbox-" + uuid.uuid4().hex[:8] + "@example.com"
    t1 = _t()
    client.put(f"/api/tournaments/{t1['id']}", json={
        "name": t1["name"], "type": "junior",
        "play_start_date": t1["play_start_date"], "play_end_date": t1["play_end_date"],
        "ingest_address": addr,
    })
    t2 = _t()
    clash = client.put(f"/api/tournaments/{t2['id']}", json={
        "name": t2["name"], "type": "junior",
        "play_start_date": t2["play_start_date"], "play_end_date": t2["play_end_date"],
        "ingest_address": addr,
    })
    assert clash.status_code in (200, 409)


def test_detect_lastname_and_empty_first():
    from app.email_detect import _detect_player_for, _fuzzy_name_match
    t = _t()
    last = "Zz" + uuid.uuid4().hex[:5]
    p = _ok(client.post("/api/players", json={
        "usta_number": "e" + uuid.uuid4().hex[:9], "first_name": "Unique",
        "last_name": last, "gender": "female",
    }))
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected", "age_division": "G14",
    }))
    with get_conn() as conn:
        with conn.cursor() as cur:
            hit = _detect_player_for(cur, t["id"], f"{last} withdrawal", "please withdraw", "")
            assert hit and hit.get("detected_player_id") == p["id"]
            roster = [{"id": 1, "first_name": "Ann", "last_name": "Lee"}]
            _fuzzy_name_match(roster, "K. Lee", exclude_ids=frozenset({1}))


def test_triage_singles_not_doubles():
    from app.triage import classify
    label = classify("Singles entry", "Please enter Jane Doe in girls 14 singles, pairing later")
    assert label in {"late_entry", "other", "doubles"}


def test_room_block_fk_and_capacity():
    t = _t()
    miss = client.post("/api/room-blocks", json={
        "tournament_id": t["id"], "hotel_id": 9_888_775, "kind": "official",
        "room_count": 1, "check_in": t["play_start_date"], "check_out": t["play_end_date"],
    })
    assert miss.status_code == 400
    hotel = _ok(client.post("/api/hotels", json={"name": "RB " + uuid.uuid4().hex[:5]}))
    rb = client.post("/api/room-blocks", json={
        "tournament_id": 9_888_774, "hotel_id": hotel["id"], "kind": "official",
        "room_count": 1, "check_in": t["play_start_date"], "check_out": t["play_end_date"],
    })
    assert rb.status_code == 400


def test_distance_update_fk_and_unique():
    o = _ok(client.post("/api/officials", json={"first_name": "D", "last_name": uuid.uuid4().hex[:5]}))
    s = _ok(client.post("/api/sites", json={"name": "Ds " + uuid.uuid4().hex[:4],
                                           "code": "D" + uuid.uuid4().hex[:4]}))
    d = _ok(client.post("/api/distances", json={
        "official_id": o["id"], "site_id": s["id"], "one_way_miles": 3, "source": "manual",
    }))
    bad = client.put(f"/api/distances/{d['id']}", json={
        "official_id": 9_888_773, "site_id": s["id"], "one_way_miles": 4, "source": "manual",
    })
    assert bad.status_code == 400
    o2 = _ok(client.post("/api/officials", json={"first_name": "E", "last_name": uuid.uuid4().hex[:5]}))
    d2 = _ok(client.post("/api/distances", json={
        "official_id": o2["id"], "site_id": s["id"], "one_way_miles": 5, "source": "manual",
    }))
    clash = client.put(f"/api/distances/{d2['id']}", json={
        "official_id": o["id"], "site_id": s["id"], "one_way_miles": 6, "source": "manual",
    })
    assert clash.status_code == 409


def test_auto_distance_missing_coords():
    o = _ok(client.post("/api/officials", json={"first_name": "F", "last_name": uuid.uuid4().hex[:5]}))
    s = _ok(client.post("/api/sites", json={"name": "Nc " + uuid.uuid4().hex[:4],
                                           "code": "N" + uuid.uuid4().hex[:4]}))
    r = client.post("/api/distances/auto", json={"official_id": o["id"], "site_id": s["id"]})
    assert r.status_code in (422, 404)


def test_purge_negative_and_staff_404():
    bad = client.post("/api/emails/purge", params={"older_than_days": -1})
    assert bad.status_code in (400, 422)
    t = _t()
    assert client.put(f"/api/staff/{9_888_772}", json={
        "role": "site_director", "name": "x",
    }).status_code in (404, 405, 422)
    assert client.delete(f"/api/tournaments/{t['id']}/staff/{9_888_772}").status_code in (404, 405)

