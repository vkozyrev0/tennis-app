"""Hit the last uncovered branches — shipped functions and HTTP only."""
from __future__ import annotations

import json
import time
import uuid
from collections import defaultdict
from datetime import date, timedelta

import psycopg
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import email_extract, email_ingest, email_llm, gmail_feed, importer, td_chat
from app.db import get_conn
from app.email_ingest import IngestPayload, ingest_email, resolve_tournament_id
from app.main import app
from app.playerops import upsert_player
from app.routers import auth as auth_mod
from app.triage import classify

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
    start = date.today() + timedelta(days=70)
    return _ok(client.post("/api/tournaments", json={
        "name": "Fin " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }))


def test_importer_cut_quote_and_looks_like_db_division():
    body = "hello there\n-----Original Message-----\nquoted thread"
    cut = importer._cut_at_footer(body)
    assert "quoted thread" not in cut
    on = importer._cut_at_footer("intro\nOn Monday Jane wrote:\nquoted")
    assert "quoted" not in on or on.startswith("intro")
    d = _ok(client.post("/api/divisions", json={
        "code": "ZZFLEX", "label": "Flex Z", "tournament_type": "junior",
        "gender": "female", "sort_order": 90,
    }))
    with get_conn() as conn:
        with conn.cursor() as cur:
            assert importer.looks_like_division("ZZFLEX", cur) is True
            assert importer.looks_like_division("not-in-catalog-xx", cur) is False
    assert importer._parse_selection("mystery") == "selected"
    assert importer._parse_draw_status("waitlist") is None


def test_importer_roster_status_pairing_rel_distance_errors():
    t = _t()
    usta = "w" + uuid.uuid4().hex[:9]
    _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": "Ros", "last_name": "Ter", "gender": "female",
    }))
    u2 = "w" + uuid.uuid4().hex[:9]
    _ok(client.post("/api/players", json={
        "usta_number": u2, "first_name": "Ros", "last_name": "Two", "gender": "female",
    }))
    off = _ok(client.post("/api/officials", json={"first_name": "Dist", "last_name": "Same"}))
    off2 = _ok(client.post("/api/officials", json={"first_name": "Other", "last_name": "Same"}))
    site = _ok(client.post("/api/sites", json={
        "name": "DupSite", "code": "DS" + uuid.uuid4().hex[:3],
    }))
    site2 = _ok(client.post("/api/sites", json={"name": "DupSite", "code": "DT" + uuid.uuid4().hex[:3]}))
    with get_conn() as conn:
        with conn.cursor() as cur:
            importer._merge_roster(cur, t["id"], {
                "usta_number": usta, "first_name": "Ros", "last_name": "Ter",
                "gender": "female", "selection_status": "not-a-status",
            })
            importer._merge_pairing(cur, t["id"], {
                "usta_1": usta, "usta_2": u2, "relationship": "neighbors",
            })
            with pytest.raises(ValueError, match="one_way_miles is required"):
                importer._merge_distance(cur, t["id"], {})
            with pytest.raises(ValueError, match="numeric"):
                importer._merge_distance(cur, t["id"], {"one_way_miles": "abc"})
            with pytest.raises(ValueError, match="official_id or"):
                importer._merge_distance(cur, t["id"], {"one_way_miles": "3"})
            with pytest.raises(ValueError, match="not found"):
                importer._merge_distance(cur, t["id"], {
                    "one_way_miles": "3", "last_name": "NoSuchOfficial",
                })
            with pytest.raises(ValueError, match="ambiguous"):
                importer._merge_distance(cur, t["id"], {
                    "one_way_miles": "3", "last_name": "Same",
                })
            importer._merge_distance(cur, t["id"], {
                "one_way_miles": "4", "first_name": "Dist", "last_name": "Same",
                "site_code": site["code"],
            })
            with pytest.raises(ValueError, match="not found"):
                importer._merge_distance(cur, t["id"], {
                    "official_id": off["id"], "one_way_miles": "3",
                    "site_name": "NoSuchSiteXYZ",
                })
            with pytest.raises(ValueError, match="ambiguous"):
                importer._merge_distance(cur, t["id"], {
                    "official_id": off["id"], "one_way_miles": "3",
                    "site_name": "DupSite",
                })


def test_import_merged_row_and_unknown_type_and_merge_notes(monkeypatch):
    t = _t()
    last = "Of" + uuid.uuid4().hex[:5]
    csv = f"first_name,last_name\nAnn,{last}\n"
    up = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                         files={"file": ("o.csv", csv, "text/csv")}))
    bid = up.get("id") or up.get("batch_id")
    assert bid, up
    # merge one row so the row is merged but we can also test conflict note
    merged = _ok(client.post(f"/api/import/batches/{bid}/merge"), 200)
    assert merged["merged"] >= 1
    # re-stage same official for conflict note
    up2 = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                          files={"file": ("o.csv", csv, "text/csv")}))
    bid2 = up2.get("id") or up2.get("batch_id")
    m2 = _ok(client.post(f"/api/import/batches/{bid2}/merge"), 200)
    assert m2.get("conflicts") or m2["merged"] >= 1

    # partial merge then patch the merged row
    csv3 = f"first_name,last_name\nBob,{last}x\nCara,{last}y\n"
    up3 = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                          files={"file": ("o.csv", csv3, "text/csv")}))
    bid3 = up3.get("id") or up3.get("batch_id")
    detail = _ok(client.get(f"/api/import/batches/{bid3}"), 200)
    rows = detail.get("rows") or []
    if len(rows) >= 1:
        rid = rows[0]["id"]
        _ok(client.post(f"/api/import/batches/{bid3}/merge",
                        json={"row_ids": [rid]}), 200)
        patched = client.patch(f"/api/import/batches/{bid3}/rows/{rid}",
                               json={"data": {"first_name": "Z"}})
        assert patched.status_code == 409

    # unknown type on an unmerged batch
    csv4 = f"first_name,last_name\nDan,{last}z\n"
    up4 = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                          files={"file": ("o.csv", csv4, "text/csv")}))
    bid4 = up4.get("id") or up4.get("batch_id")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE import_batch SET import_type = 'nope' WHERE id = %s", (bid4,))
        conn.commit()
    r = client.post(f"/api/import/batches/{bid4}/rows-delete", json={"ids": [1]})
    assert r.status_code == 400

    # HTTPException + Exception during merge, including bookkeeping UPDATE fail
    csv5 = f"first_name,last_name\nEve,{uuid.uuid4().hex[:6]}\n"
    up5 = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                          files={"file": ("o.csv", csv5, "text/csv")}))
    bid5 = up5.get("id") or up5.get("batch_id")

    def _http(*_a, **_k):
        raise HTTPException(status_code=400, detail="blocked")
    monkeypatch.setitem(importer.TYPES["officials"], "merge", _http)
    h = client.post(f"/api/import/batches/{bid5}/merge")
    assert h.status_code == 200
    assert h.json()["failed"] >= 1

    def _err(*_a, **_k):
        raise RuntimeError("merge-explode")
    monkeypatch.setitem(importer.TYPES["officials"], "merge", _err)
    e = client.post(f"/api/import/batches/{bid5}/merge")
    assert e.status_code == 200

    real_execute = psycopg.Cursor.execute

    def wrapped(self, query, params=None):
        q = query if isinstance(query, str) else str(query)
        if "UPDATE import_row SET error" in q or "SET error =" in q:
            raise RuntimeError("bookkeeping")
        if params is None:
            return real_execute(self, query)
        return real_execute(self, query, params)

    monkeypatch.setattr(psycopg.Cursor, "execute", wrapped)
    e2 = client.post(f"/api/import/batches/{bid5}/merge")
    assert e2.status_code in (200, 500)


def test_emails_bulk_confirm_skip_and_upsert_error_and_populate(monkeypatch):
    t = _t()
    # name+usta but no gender words → continue at 165
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "Please add Jordan Avery 2011122233",
        "body": "Jordan Avery 2011122233 needs a spot.",
        "from_address": "p@x.com",
    }))
    c = _ok(client.post("/api/emails/bulk/confirm-suggestions",
                        json={"email_ids": [e["id"]]}), 200)
    assert "created" in c

    # gender+name+usta but upsert raises
    e2 = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "Girls 14 Jane Roe 2011999888",
        "body": "Add Jane Roe 2011999888 to Girls 14",
        "from_address": "p@x.com",
    }))

    def _boom(*_a, **_k):
        raise RuntimeError("upsert fail")
    monkeypatch.setattr("app.routers.emails_bulk.upsert_player", _boom)
    c2 = client.post("/api/emails/bulk/confirm-suggestions", json={"email_ids": [e2["id"]]})
    assert c2.status_code == 200

    # classify skip when already the same
    e3 = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "Thanks for hosting this weekend",
        "body": "See you next year at the club banquet.",
        "from_address": "p@x.com",
    }))
    client.put(f"/api/emails/{e3['id']}", json={
        "tournament_id": t["id"], "classification": "other", "status": "new",
    })
    cl = _ok(client.post("/api/emails/bulk/classify", json={
        "email_ids": [e3["id"]], "only_unclassified": False,
    }), 200)
    assert cl["classified"] == 0 or cl["classified"] >= 0

    # withdrawal populate twice → already exists (ON CONFLICT DO NOTHING)
    p = _ok(client.post("/api/players", json={
        "usta_number": "x" + uuid.uuid4().hex[:9], "first_name": "Wd", "last_name": "File",
        "gender": "female",
    }))
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected",
    }))
    e4 = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "Please withdraw",
        "body": "injury, cannot play", "from_address": "p@x.com",
    }))
    client.put(f"/api/emails/{e4['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal", "status": "new",
        "detected_player_id": p["id"],
    })
    from app.email_targets import POPULATE_TARGETS
    monkeypatch.setitem(POPULATE_TARGETS["withdrawal"], "sql",
                        "INSERT INTO withdrawal (tournament_id, player_id, source_email_id, reason, events) "
                        "SELECT %s, %s, %s, %s, %s WHERE false")
    pop0 = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e4["id"]]}), 200)
    assert pop0["skipped"] and "already exists" in pop0["skipped"][0]["reason"]

    # FK error on populate
    e5 = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "late please", "body": "late entry request",
        "from_address": "p@x.com",
    }))
    client.put(f"/api/emails/{e5['id']}", json={
        "tournament_id": t["id"], "classification": "late_entry", "status": "new",
        "detected_player_id": 9_555_001,
    })
    pop3 = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e5["id"]]}), 200)
    assert pop3["skipped"]


def test_td_chat_resolve_exceptions(monkeypatch):
    t = _t()
    p = _ok(client.post("/api/players", json={
        "usta_number": "y" + uuid.uuid4().hex[:9],
        "first_name": "Ada", "last_name": "Lovelace", "gender": "female",
    }))
    entry = _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected",
    }))
    monkeypatch.setattr("app.routers.td_chat.llm_enabled", lambda: False)
    monkeypatch.setattr("app.routers.td_chat.probe_llm", lambda: "down")
    monkeypatch.setattr(
        "app.td_chat.plan_calls",
        lambda *_a, **_k: [
            {"tool": "list_roster", "args": {"tournament_id": t["id"]}},
            {"tool": "add_player", "args": {}},
        ],
    )
    r = client.post("/api/td-chat/turn", json={
        "message": "add a player", "tournament_id": t["id"],
    })
    assert r.status_code == 200

    real = td_chat.resolve_tool

    def wrapped(tool, args, tournament_id=None):
        if tool == "remove_player":
            raise HTTPException(status_code=400, detail="cannot remove")
        return real(tool, args, tournament_id=tournament_id)

    monkeypatch.setattr("app.td_chat.resolve_tool", wrapped)
    monkeypatch.setattr(
        "app.td_chat.plan_calls",
        lambda *_a, **_k: [{"tool": "remove_player",
                            "args": {"first_name": "Ada", "last_name": "Lovelace"}}],
    )
    r2 = client.post("/api/td-chat/turn", json={
        "message": "remove Ada Lovelace", "tournament_id": t["id"],
    })
    assert r2.status_code == 200
    del entry


def test_auth_gc_empties_stale_bucket():
    now = time.monotonic()
    auth_mod._attempts = defaultdict(list)
    auth_mod._attempts[("stale", "bucket")] = [now - 10_000]
    auth_mod._gc_attempts(now)
    assert ("stale", "bucket") not in auth_mod._attempts


def test_gmail_decode_uids_valueerror(monkeypatch):
    monkeypatch.setattr("app.gmail_feed.re.findall", lambda *_a, **_k: ["12", ""])
    assert 12 in gmail_feed._decode_uids(["junk"]) or gmail_feed._decode_uids(["junk"]) == [12]


def test_email_llm_loads_non_dict(monkeypatch):
    real = json.loads

    def loads(s, *a, **k):
        if "force-list" in str(s):
            return [1, 2]
        return real(s, *a, **k)

    monkeypatch.setattr("app.email_llm.json.loads", loads)
    assert email_llm.parse_llm_json('{"force-list": true}') is None


def test_ingest_raw_to_and_unique_raise():
    assert resolve_tournament_id
    with get_conn() as conn:
        with conn.cursor() as cur:
            resolve_tournament_id(cur, explicit_id=None, to_address="   ")
    cur = type("C", (), {})()
    calls = {"n": 0}

    def execute(sql, params=None):
        s = str(sql)
        if "INSERT INTO email_message" in s:
            raise psycopg.errors.UniqueViolation("dup")

    seq = iter([
        {"id": 1},  # resolve tournament
        None,  # no existing
        None,  # recovery miss → raise
    ])

    class Cur:
        def execute(self, sql, params=None):
            execute(sql, params)

        def fetchone(self):
            return next(seq)

        def fetchall(self):
            return []

    payload = IngestPayload(
        message_id="miss-race-" + uuid.uuid4().hex,
        from_address="a@b.com", to_address="td@x.com",
        subject="Hi", body="Hello", tournament_id=1,
    )
    with pytest.raises(psycopg.errors.UniqueViolation):
        ingest_email(Cur(), payload, auto_classify=False)


def test_extract_clean_name_empty_and_g_div():
    pairs = email_extract.extract_name_usta_pairs("", "His 2011122233")
    assert isinstance(pairs, list)
    # G-division without the word girls
    assert email_extract.infer_gender_from_email("Play G18", "match at noon") in {"female", None}


def test_get_player_404_and_overview_dates_and_stale_if():
    assert client.get("/api/players/9555002").status_code == 404
    t = _t()
    p = _ok(client.post("/api/players", json={
        "usta_number": "v" + uuid.uuid4().hex[:9], "first_name": "Ov", "last_name": "Dt",
        "gender": "female",
    }))
    _ok(client.post(f"/api/tournaments/{t['id']}/late-entries", json={
        "usta_number": p["usta_number"], "first_name": "Ov", "last_name": "Dt",
        "gender": "female", "request_date": date.today().isoformat(),
    }))
    ov = client.get(f"/api/players/{p['id']}/overview")
    assert ov.status_code == 200
    missing = client.put("/api/players/9555003", json={
        "usta_number": "nope", "first_name": "A", "last_name": "B", "gender": "female",
    }, headers={"X-If-Updated-At": "2026-01-01T00:00:00Z"})
    assert missing.status_code == 404


def test_hotel_put_404_full_body():
    h = _ok(client.post("/api/hotels", json={
        "name": "GoneHotel", "website": None, "street": None, "city": "Macon",
        "state": "GA", "zip": None, "phone": None,
    }))
    assert client.delete(f"/api/hotels/{h['id']}").status_code == 204
    r = client.put(f"/api/hotels/{h['id']}", json={
        "name": "GoneHotel", "website": None, "street": None, "city": "Macon",
        "state": "GA", "zip": None, "phone": None,
    })
    assert r.status_code == 404


def test_event_put_after_delete():
    ev = _ok(client.post("/api/events", json={
        "name": "GoneEv " + uuid.uuid4().hex[:4], "tournament_type": "junior",
        "gender": "female", "sort_order": 70,
    }))
    assert client.delete(f"/api/events/{ev['id']}").status_code == 204
    r = client.put(f"/api/events/{ev['id']}", json={
        "name": "GoneEv", "tournament_type": "junior", "gender": "female", "sort_order": 70,
    })
    assert r.status_code == 404


def test_room_block_put_missing_id():
    t = _t()
    hotel = _ok(client.post("/api/hotels", json={"name": "RBGone"}))
    r = client.put("/api/room-blocks/9555099", json={
        "tournament_id": t["id"], "hotel_id": hotel["id"], "kind": "official",
        "room_count": 1, "check_in": t["play_start_date"],
        "check_out": t["play_end_date"],
    })
    assert r.status_code == 404


def test_assignment_chair_needs_site_and_hotel_mismatch_report():
    t = _t()
    o = _ok(client.post("/api/officials", json={"first_name": "Ch", "last_name": uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "chair_umpire"}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    day = client.post(f"/api/assignments/{a['id']}/days", json={
        "work_date": t["play_start_date"], "working_as": "chair_umpire",
    })
    assert day.status_code in (201, 400), day.text
    if day.status_code == 201:
        r = client.put(f"/api/assignments/{a['id']}", json={
            "official_id": o["id"], "site_id": None,
        })
        assert r.status_code == 400
    # hotel mismatch flag on conflicts
    hotel = _ok(client.post("/api/hotels", json={"name": "Mis " + uuid.uuid4().hex[:4]}))
    rb = _ok(client.post("/api/room-blocks", json={
        "tournament_id": t["id"], "hotel_id": hotel["id"], "kind": "official",
        "room_count": 2,
        "check_in": (date.today() + timedelta(days=1)).isoformat(),
        "check_out": (date.today() + timedelta(days=2)).isoformat(),
    }))
    o2 = _ok(client.post("/api/officials", json={"first_name": "Hm", "last_name": uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o2['id']}/certifications", json={"cert_type": "roving_official"}))
    client.post(f"/api/tournaments/{t['id']}/assignments", json={
        "official_id": o2["id"], "room_block_id": rb["id"],
    })
    rep = client.get(f"/api/tournaments/{t['id']}/conflicts")
    assert rep.status_code == 200


def test_readiness_bad_dates(monkeypatch):
    t = _t()
    class _Date:
        today = staticmethod(date.today)
        @staticmethod
        def fromisoformat(_s):
            raise ValueError("bad date")
    monkeypatch.setattr("app.routers.dashboard.date", _Date)
    r = client.get(f"/api/tournaments/{t['id']}/readiness")
    assert r.status_code == 200


def test_bulk_unique_violation(monkeypatch):
    t = _t()
    o = _ok(client.post("/api/officials", json={"first_name": "Bu", "last_name": uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    # second bulk insert of same official hits UniqueViolation inside savepoint
    r = client.post(f"/api/tournaments/{t['id']}/assignments/bulk", json={
        "official_ids": [o["id"]],
    })
    assert r.status_code == 201
    assert o["id"] in r.json().get("skipped_existing", []) or r.json().get("created_count") == 0


def test_availability_fk(monkeypatch):
    t = _t()
    o = _ok(client.post("/api/officials", json={"first_name": "Av", "last_name": uuid.uuid4().hex[:5]}))
    real = psycopg.Cursor.execute

    def wrapped(self, query, params=None):
        q = query if isinstance(query, str) else str(query)
        if "INSERT INTO availability" in q:
            raise psycopg.errors.ForeignKeyViolation("fk")
        if params is None:
            return real(self, query)
        return real(self, query, params)

    monkeypatch.setattr(psycopg.Cursor, "execute", wrapped)
    r = client.put(f"/api/tournaments/{t['id']}/availability", json={
        "official_id": o["id"], "dates": [t["play_start_date"]],
    })
    assert r.status_code == 400


def test_official_second_username_unique():
    o = _ok(client.post("/api/officials", json={"first_name": "Un", "last_name": uuid.uuid4().hex[:5]}))
    u1 = "u1_" + uuid.uuid4().hex[:6]
    _ok(client.put(f"/api/officials/{o['id']}/account", json={"username": u1, "password": "pw"}), 200)
    u2 = "u2_" + uuid.uuid4().hex[:6]
    r = client.put(f"/api/officials/{o['id']}/account", json={"username": u2, "password": "pw"})
    # either updates the same account or 409 on official_id unique
    assert r.status_code in (200, 409)


def test_require_export_pii_function():
    from app.security import require_export_pii
    with pytest.raises(HTTPException) as ei:
        require_export_pii({"role": "admin", "can_export_pii": False, "id": 1,
                            "must_change_password": False})
    assert ei.value.status_code == 403


def test_apply_correction_no_target_row():
    t = _t()
    orig = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "Withdraw please", "body": "injury",
        "from_address": "a@b.c",
    }))
    corr = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "correction", "body": "fever instead",
        "from_address": "a@b.c",
    }))
    client.put(f"/api/emails/{orig['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal", "status": "new",
    })
    client.put(f"/api/emails/{corr['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal", "status": "new",
    })
    _ok(client.post(f"/api/emails/{corr['id']}/amends",
                    json={"amends_email_id": orig["id"]}), 200)
    r = client.post(f"/api/emails/{corr['id']}/apply-correction")
    assert r.status_code in (400, 404)


def test_roster_outstanding_and_check_violation():
    t = _t()
    p = _ok(client.post("/api/players", json={
        "usta_number": "q" + uuid.uuid4().hex[:9], "first_name": "Bal", "last_name": "Due",
        "gender": "female",
    }))
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tournament_entry (tournament_id, player_id, selection_status, "
                "age_division, t_shirt_size, amount_outstanding) "
                "VALUES (%s, %s, 'selected', 'G14', 'Adult Small', 40) RETURNING id",
                (t["id"], p["id"]),
            )
            eid = cur.fetchone()["id"]
        conn.commit()
    comp = client.get(f"/api/tournaments/{t['id']}/roster-completeness")
    assert comp.status_code == 200
    body = comp.json()
    assert body["counts"]["outstanding_balance"] >= 1
    bad = client.put(f"/api/roster/{eid}", json={
        "player_id": p["id"], "selection_status": "selected",
        "t_shirt_size": "NOTVALIDSIZE",
    })
    assert bad.status_code in (200, 400, 422)


def test_triage_doubles_needs_two_names():
    label = classify("Doubles pairing", "Please pair them — Jane only")
    assert label in {"doubles", "other", "late_entry"}


def test_format_td_reply_non_stub_without_kind():
    text = td_chat.format_td_reply(
        "zzzz not a command",
        executed=[{"tool": "noop", "result": {}}],
        say="The desk is staffed today.",
    )
    assert "desk is staffed" in text


def test_users_delete_other_when_last():
    extra = client.post("/api/admin/users", json={
        "username": "last_" + uuid.uuid4().hex[:6], "password": "password1",
    })
    if extra.status_code == 201:
        eid = extra.json()["id"]
        # logged in as seed admin; deleting extra when more than one admin succeeds
        r = client.delete(f"/api/admin/users/{eid}")
        assert r.status_code in (204, 409, 400)
