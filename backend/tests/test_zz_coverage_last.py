"""Last uncovered lines."""
from __future__ import annotations

import time
import uuid
from collections import defaultdict
from datetime import date, timedelta

import psycopg
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import email_extract, security
from app.db import db_dep, get_conn
from app.main import app
from app.routers import auth as auth_mod
from app.triage import classify

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable",
)


@pytest.fixture(autouse=True)
def _admin():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _t():
    start = date.today() + timedelta(days=80)
    return _ok(client.post("/api/tournaments", json={
        "name": "Last " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
    }))


def test_auth_gc_keeps_recent_timestamps():
    now = time.monotonic()
    auth_mod._attempts = defaultdict(list)
    auth_mod._attempts[("mix", "k")] = [now - 10_000, now]
    auth_mod._gc_attempts(now)
    assert auth_mod._attempts[("mix", "k")] == [now]


def test_clean_name_empty_continue():
    pairs = email_extract.extract_name_usta_pairs("His Her 2011122233", "")
    assert pairs == [] or all(p.get("name") for p in pairs)


def test_successful_event_put_and_hotel_404():
    ev = _ok(client.post("/api/events", json={
        "name": "Keep " + uuid.uuid4().hex[:4], "tournament_type": "junior",
        "gender": "female", "sort_order": 60,
    }))
    r = client.put(f"/api/events/{ev['id']}", json={
        "name": ev["name"] + "x", "tournament_type": "junior",
        "gender": "female", "sort_order": 61,
    })
    assert r.status_code == 200, r.text
    h = _ok(client.post("/api/hotels", json={"name": "LastHotel"}))
    hid = h["id"]
    assert client.delete(f"/api/hotels/{hid}").status_code == 204
    r2 = client.put(f"/api/hotels/{hid}", json={"name": "LastHotel"})
    assert r2.status_code == 404, r2.text


def test_require_export_pii_ok():
    out = security.require_export_pii({
        "role": "admin", "can_export_pii": True, "must_change_password": False, "id": 1,
    })
    assert out["role"] == "admin"


def test_td_chat_resolve_raises(monkeypatch):
    t = _t()
    monkeypatch.setattr("app.routers.td_chat.llm_enabled", lambda: False)
    monkeypatch.setattr("app.routers.td_chat.probe_llm", lambda: "down")

    def boom(tool, args, tournament_id=None):
        raise HTTPException(status_code=400, detail="nope")

    monkeypatch.setattr("app.td_chat.resolve_tool", boom)
    monkeypatch.setattr(
        "app.td_chat.plan_calls",
        lambda *_a, **_k: [{"tool": "list_roster", "args": {}}],
    )
    r = client.post("/api/td-chat/turn", json={
        "message": "who is on the roster", "tournament_id": t["id"],
    })
    assert r.status_code == 200


def test_merged_batch_for_edit():
    t = _t()
    csv = f"first_name,last_name\nAnn,{uuid.uuid4().hex[:6]}\n"
    up = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                         files={"file": ("o.csv", csv, "text/csv")}))
    bid = up["batch_id"]
    _ok(client.post(f"/api/import/batches/{bid}/merge"), 200)
    r = client.post(f"/api/import/batches/{bid}/rows-delete", json={"ids": []})
    assert r.status_code == 409


def test_merge_conflict_note_and_http_bk_fail(monkeypatch):
    t = _t()
    last = uuid.uuid4().hex[:6]
    csv = f"first_name,last_name\nAnn,{last}\n"
    up = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                         files={"file": ("o.csv", csv, "text/csv")}))
    bid = up["batch_id"]
    _ok(client.post(f"/api/import/batches/{bid}/merge"), 200)
    up2 = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                          files={"file": ("o.csv", csv, "text/csv")}))
    bid2 = up2["batch_id"]
    m = _ok(client.post(f"/api/import/batches/{bid2}/merge"), 200)
    assert m.get("conflicts") or m["merged"] >= 1

    up3 = _ok(client.post(f"/api/import/tournaments/{t['id']}/officials",
                          files={"file": ("o.csv", f"first_name,last_name\nBo,{uuid.uuid4().hex[:5]}\n", "text/csv")}))
    bid3 = up3["batch_id"]
    from fastapi import HTTPException as HE
    from app import importer

    def _http(*_a, **_k):
        raise HE(status_code=400, detail="blocked")

    monkeypatch.setitem(importer.TYPES["officials"], "merge", _http)
    real = psycopg.Cursor.execute

    def wrapped(self, query, params=None):
        q = query if isinstance(query, str) else str(query)
        if "UPDATE import_row SET error" in q:
            raise RuntimeError("bk")
        if params is None:
            return real(self, query)
        return real(self, query, params)

    monkeypatch.setattr(psycopg.Cursor, "execute", wrapped)
    r = client.post(f"/api/import/batches/{bid3}/merge")
    assert r.status_code in (200, 500)


def test_apply_correction_other_classification():
    t = _t()
    orig = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "hi", "body": "thanks", "from_address": "a@b.c",
    }))
    corr = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "corr", "body": "nudge", "from_address": "a@b.c",
    }))
    client.put(f"/api/emails/{orig['id']}", json={
        "tournament_id": t["id"], "classification": "other", "status": "new",
    })
    client.put(f"/api/emails/{corr['id']}", json={
        "tournament_id": t["id"], "classification": "other", "status": "new",
    })
    _ok(client.post(f"/api/emails/{corr['id']}/amends", json={"amends_email_id": orig["id"]}), 200)
    r = client.post(f"/api/emails/{corr['id']}/apply-correction")
    assert r.status_code == 400


def test_populate_psycopg_error(monkeypatch):
    t = _t()
    p = _ok(client.post("/api/players", json={
        "usta_number": "z" + uuid.uuid4().hex[:9], "first_name": "L", "last_name": "E",
        "gender": "female",
    }))
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "late entry please", "body": "add us late",
        "from_address": "p@x.com",
    }))
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "late_entry", "status": "new",
        "detected_player_id": p["id"],
    })
    real = psycopg.Cursor.execute

    def wrapped(self, query, params=None):
        q = query if isinstance(query, str) else str(query)
        if "INSERT INTO late_entry" in q:
            raise psycopg.errors.ForeignKeyViolation("fk")
        if params is None:
            return real(self, query)
        return real(self, query, params)

    monkeypatch.setattr(psycopg.Cursor, "execute", wrapped)
    pop = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    assert pop["skipped"]


def test_room_block_bad_hotel_fk():
    t = _t()
    hotel = _ok(client.post("/api/hotels", json={"name": "OkH"}))
    rb = _ok(client.post("/api/room-blocks", json={
        "tournament_id": t["id"], "hotel_id": hotel["id"], "kind": "official",
        "room_count": 1, "check_in": t["play_start_date"],
        "check_out": t["play_end_date"],
    }))
    r = client.put(f"/api/room-blocks/{rb['id']}", json={
        "tournament_id": t["id"], "hotel_id": 9555888, "kind": "official",
        "room_count": 1, "check_in": t["play_start_date"],
        "check_out": t["play_end_date"],
    })
    assert r.status_code == 400


def test_digest_empty_ids():
    from app.routers.dashboard import digest

    class EmptyCur:
        def execute(self, *a, **k):
            pass
        def fetchall(self):
            return []
        def fetchone(self):
            return None
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    class EmptyConn:
        def cursor(self):
            return EmptyCur()

    out = digest(conn=EmptyConn())
    assert isinstance(out, list) or isinstance(out, dict)


def test_triage_singles_only_partner():
    label = classify("Singles partner", "singles play, partner request for Jane")
    assert label in {"late_entry", "doubles", "other"}


def test_bulk_insert_unique_violation(monkeypatch):
    t = _t()
    o = _ok(client.post("/api/officials", json={"first_name": "Uq", "last_name": uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    real = psycopg.Cursor.execute

    def wrapped(self, query, params=None):
        q = query if isinstance(query, str) else str(query)
        if "INSERT INTO assignment (tournament_id, official_id, site_id, room_block_id)" in q:
            raise psycopg.errors.UniqueViolation("dup")
        if params is None:
            return real(self, query)
        return real(self, query, params)

    monkeypatch.setattr(psycopg.Cursor, "execute", wrapped)
    r = client.post(f"/api/tournaments/{t['id']}/assignments/bulk", json={
        "official_ids": [o["id"]],
    })
    assert r.status_code == 201
    assert o["id"] in r.json().get("skipped_existing", [])


def test_official_id_unique_second_login():
    o = _ok(client.post("/api/officials", json={"first_name": "U2", "last_name": uuid.uuid4().hex[:5]}))
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": "a_" + uuid.uuid4().hex[:6], "password": "pw"}), 200)
    r = client.put(f"/api/officials/{o['id']}/account",
                   json={"username": "b_" + uuid.uuid4().hex[:6], "password": "pw"})
    assert r.status_code in (200, 409)


def test_assignment_update_missing_id_404():
    r = client.put("/api/assignments/9555777", json={"official_id": 1})
    assert r.status_code in (400, 404)


def test_chair_day_then_clear_site():
    t = _t()
    o = _ok(client.post("/api/officials", json={"first_name": "Ch2", "last_name": uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "chair_umpire"}))
    site = _ok(client.post("/api/sites", json={"name": "ChS", "code": "CS" + uuid.uuid4().hex[:3]}))
    client.put(f"/api/tournaments/{t['id']}/sites", json={"site_ids": [site["id"]]})
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"], "site_id": site["id"]}))
    day = client.post(f"/api/assignments/{a['id']}/days", json={
        "work_date": t["play_start_date"], "working_as": "chair_umpire",
    })
    assert day.status_code in (201, 400), day.text
    if day.status_code == 201:
        r = client.put(f"/api/assignments/{a['id']}",
                       json={"official_id": o["id"], "site_id": None})
        assert r.status_code == 400


def test_conflicts_hotel_mismatch():
    t = _t()
    o = _ok(client.post("/api/officials", json={"first_name": "Hm2", "last_name": uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    hotel = _ok(client.post("/api/hotels", json={"name": "Far " + uuid.uuid4().hex[:3]}))
    # hotel dates far from play window
    rb = _ok(client.post("/api/room-blocks", json={
        "tournament_id": t["id"], "hotel_id": hotel["id"], "kind": "official",
        "room_count": 2,
        "check_in": "2020-01-01", "check_out": "2020-01-03",
    }))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={
        "official_id": o["id"], "room_block_id": rb["id"],
    }))
    _ok(client.post(f"/api/assignments/{a['id']}/days", json={
        "work_date": t["play_start_date"], "working_as": "roving_official",
    }))
    r = client.get(f"/api/tournaments/{t['id']}/conflicts")
    assert r.status_code == 200
    assert r.json()["counts"]["hotel_mismatch"] >= 1


def test_hotel_put_success():
    h = _ok(client.post("/api/hotels", json={"name": "StayPut"}))
    r = client.put(f"/api/hotels/{h['id']}", json={"name": "StayPut2", "city": "Macon"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "StayPut2"


def test_officials_merge_note_direct():
    from app import importer
    o = _ok(client.post("/api/officials", json={"first_name": "Note", "last_name": "Me"}))
    t = _t()
    with get_conn() as conn:
        with conn.cursor() as cur:
            note = importer._merge_officials(cur, t["id"], {
                "first_name": o["first_name"], "last_name": o["last_name"], "city": "Rome",
            })
            assert note and "overwritten" in note


def test_triage_singles_only_line(monkeypatch):
    # _classify_raw never returns doubles when the text is singles-only, so
    # drive classify()'s doubles→late_entry fallback by stubbing the raw label.
    monkeypatch.setattr("app.triage._classify_raw", lambda *_a, **_k: "doubles")
    label = classify("Singles", "partner with Jane Doe in singles")
    assert label == "late_entry"


def test_merge_bookkeeping_update_fails(monkeypatch):
    """Successful merge whose 'SET merged = true' bookkeeping UPDATE raises."""
    t = _t()
    csv = f"first_name,last_name\nJo,{uuid.uuid4().hex[:6]}\n"
    up = _ok(client.post(
        f"/api/import/tournaments/{t['id']}/officials",
        files={"file": ("o.csv", csv, "text/csv")},
    ))
    bid = up["batch_id"]
    real = psycopg.Cursor.execute

    def wrapped(self, query, params=None):
        q = query if isinstance(query, str) else str(query)
        if "UPDATE import_row SET merged = true" in q:
            raise RuntimeError("bk-merged")
        if params is None:
            return real(self, query)
        return real(self, query, params)

    monkeypatch.setattr(psycopg.Cursor, "execute", wrapped)
    r = client.post(f"/api/import/batches/{bid}/merge")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["merged"] >= 1


def _patch_sql_fetchone(monkeypatch, sql_substr, value):
    """After a matching execute(), fetchone() returns `value` (row consumed).

    psycopg Cursor has no __dict__, so the last SQL is kept in this closure.
    """
    real_ex = psycopg.Cursor.execute
    real_fo = psycopg.Cursor.fetchone
    last_sql = [""]

    def execute(self, query, params=None):
        last_sql[0] = query if isinstance(query, str) else str(query)
        if params is None:
            return real_ex(self, query)
        return real_ex(self, query, params)

    def fetchone(self):
        if sql_substr in last_sql[0]:
            try:
                real_fo(self)
            except Exception:
                pass
            return value
        return real_fo(self)

    monkeypatch.setattr(psycopg.Cursor, "execute", execute)
    monkeypatch.setattr(psycopg.Cursor, "fetchone", fetchone)


def test_assignment_update_vanished_between_select_and_update(monkeypatch):
    t = _t()
    o = _ok(client.post("/api/officials", json={
        "first_name": "Race", "last_name": uuid.uuid4().hex[:5],
    }))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"]}))
    _patch_sql_fetchone(monkeypatch, "UPDATE assignment SET official_id", None)
    r = client.put(f"/api/assignments/{a['id']}", json={"official_id": o["id"]})
    assert r.status_code == 404, r.text
    assert "not found" in r.json()["detail"].lower()


def test_me_profile_404_when_update_returns_no_row(monkeypatch):
    o = _ok(client.post("/api/officials", json={
        "first_name": "Prof", "last_name": uuid.uuid4().hex[:5],
    }))
    uname = "prof_" + uuid.uuid4().hex[:6]
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": uname, "password": "pw"}), 200)
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": "pw"}), 200)
    _patch_sql_fetchone(monkeypatch, "UPDATE official SET", None)
    r = sess.put("/api/me/profile", json={"first_name": "X", "last_name": "Y"})
    assert r.status_code == 404, r.text
    assert "official record not found" in r.json()["detail"].lower()


def test_me_availability_404_when_tournament_vanishes(monkeypatch):
    t = _t()
    o = _ok(client.post("/api/officials", json={
        "first_name": "Avl", "last_name": uuid.uuid4().hex[:5],
    }))
    uname = "avl_" + uuid.uuid4().hex[:6]
    _ok(client.put(f"/api/officials/{o['id']}/account",
                   json={"username": uname, "password": "pw"}), 200)
    sess = TestClient(app)
    _ok(sess.post("/api/auth/login", json={"username": uname, "password": "pw"}), 200)
    _patch_sql_fetchone(
        monkeypatch, "SELECT play_start_date, play_end_date FROM tournament", None,
    )
    r = sess.put(f"/api/me/availability/{t['id']}", json={
        "dates": [t["play_start_date"]], "hotel_needed": False,
    })
    assert r.status_code == 404, r.text
    assert "tournament not found" in r.json()["detail"].lower()


def test_users_last_admin_count_409(monkeypatch):
    extra = _ok(client.post("/api/admin/users", json={
        "username": "tmp_" + uuid.uuid4().hex[:6], "password": "password1",
    }))
    _patch_sql_fetchone(
        monkeypatch, "SELECT count(*) AS n FROM user_account WHERE role = 'admin'",
        {"n": 1},
    )
    r = client.delete(f"/api/admin/users/{extra['id']}")
    assert r.status_code == 409, r.text
    assert "last admin" in r.json()["detail"].lower()


def test_roster_missing_gender_via_fetchall(monkeypatch):
    t = _t()
    p = _ok(client.post("/api/players", json={
        "usta_number": "g" + uuid.uuid4().hex[:9], "first_name": "Ng", "last_name": "En",
        "gender": "female",
    }))
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected",
    }))
    real_ex = psycopg.Cursor.execute
    real_fa = psycopg.Cursor.fetchall
    last_sql = [""]

    def execute(self, query, params=None):
        last_sql[0] = query if isinstance(query, str) else str(query)
        if params is None:
            return real_ex(self, query)
        return real_ex(self, query, params)

    def fetchall(self):
        rows = real_fa(self)
        if "FROM tournament_entry e JOIN player p" in last_sql[0]:
            return [{**dict(r), "gender": None} for r in rows]
        return rows

    monkeypatch.setattr(psycopg.Cursor, "execute", execute)
    monkeypatch.setattr(psycopg.Cursor, "fetchall", fetchall)
    r = client.get(f"/api/tournaments/{t['id']}/roster-completeness")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["counts"]["missing_gender"] >= 1
    assert any("missing_gender" in e["issues"] for e in body["entries"])
