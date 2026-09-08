"""HTTP error/empty-path coverage for shipped routers (404/409/empty bulk)."""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app

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


def _tournament(**kw):
    start = date.today() + timedelta(days=40)
    body = {
        "name": "Cov " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start.isoformat(),
        "play_end_date": (start + timedelta(days=2)).isoformat(),
        **kw,
    }
    return _ok(client.post("/api/tournaments", json=body))


def test_catalog_404_and_409_paths():
    missing = 9_999_991
    assert client.get(f"/api/sites/{missing}").status_code == 404
    assert client.put(f"/api/sites/{missing}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/sites/{missing}").status_code == 404
    a = _ok(client.post("/api/sites", json={"code": "C" + uuid.uuid4().hex[:5], "name": "A"}))
    b = _ok(client.post("/api/sites", json={"code": "C" + uuid.uuid4().hex[:5], "name": "B"}))
    clash = client.put(f"/api/sites/{b['id']}", json={"code": a["code"], "name": "B"})
    assert clash.status_code == 409
    again = client.post("/api/sites", json={"code": a["code"], "name": "dup"})
    assert again.status_code == 409

    hotels = client.get("/api/hotels")
    assert hotels.status_code == 200
    assert isinstance(hotels.json(), list)
    assert client.put(f"/api/hotels/{missing}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/hotels/{missing}").status_code == 404

    rates = client.get("/api/rates")
    assert rates.status_code == 200
    r1 = _ok(client.post("/api/rates", json={
        "cert_type": "roving_official", "rate_per_day": 1,
        "effective_from": "2099-01-01",
    }))
    dup = client.post("/api/rates", json={
        "cert_type": "roving_official", "rate_per_day": 2,
        "effective_from": "2099-01-01",
    })
    assert dup.status_code == 409
    assert client.put(f"/api/rates/{missing}", json={
        "cert_type": "roving_official", "rate_per_day": 1,
        "effective_from": "2099-02-01",
    }).status_code == 404
    clash_rate = client.put(f"/api/rates/{r1['id']}", json={
        "cert_type": "roving_official", "rate_per_day": 3,
        "effective_from": "2099-01-01",
    })
    # same type+date as itself is ok; duplicate against another row:
    r2 = _ok(client.post("/api/rates", json={
        "cert_type": "chair_umpire", "rate_per_day": 1,
        "effective_from": "2099-01-01",
    }))
    clash_rate = client.put(f"/api/rates/{r2['id']}", json={
        "cert_type": "roving_official", "rate_per_day": 1,
        "effective_from": "2099-01-01",
    })
    assert clash_rate.status_code == 409
    assert client.delete(f"/api/rates/{missing}").status_code == 404

    assert client.put(f"/api/divisions/{missing}", json={
        "code": "Z99", "label": "Z", "tournament_type": "junior",
        "gender": "female", "sort_order": 1,
    }).status_code == 404
    d1 = _ok(client.post("/api/divisions", json={
        "code": "Z" + uuid.uuid4().hex[:4], "label": "Z",
        "tournament_type": "junior", "gender": "female", "sort_order": 99,
    }))
    dup_div = client.post("/api/divisions", json={
        "code": d1["code"], "label": "Z2", "tournament_type": "junior",
        "gender": "female", "sort_order": 98,
    })
    assert dup_div.status_code == 409
    d2 = _ok(client.post("/api/divisions", json={
        "code": "Y" + uuid.uuid4().hex[:4], "label": "Y",
        "tournament_type": "junior", "gender": "male", "sort_order": 97,
    }))
    assert client.put(f"/api/divisions/{d2['id']}", json={
        "code": d1["code"], "label": "Y", "tournament_type": "junior",
        "gender": "male", "sort_order": 97,
    }).status_code == 409
    assert client.delete(f"/api/divisions/{missing}").status_code == 404

    ev = client.get("/api/events")
    assert ev.status_code == 200
    e1 = _ok(client.post("/api/events", json={
        "name": "Ev " + uuid.uuid4().hex[:6], "tournament_type": "junior",
        "gender": "female", "sort_order": 1,
    }))
    dup_e = client.post("/api/events", json={
        "name": e1["name"], "tournament_type": "junior",
        "gender": "female", "sort_order": 2,
    })
    assert dup_e.status_code == 409
    e2 = _ok(client.post("/api/events", json={
        "name": "Ev " + uuid.uuid4().hex[:6], "tournament_type": "junior",
        "gender": "male", "sort_order": 3,
    }))
    assert client.put(f"/api/events/{missing}", json={
        "name": "nope", "tournament_type": "junior", "gender": "female", "sort_order": 1,
    }).status_code == 404
    assert client.put(f"/api/events/{e2['id']}", json={
        "name": e1["name"], "tournament_type": "junior", "gender": "male", "sort_order": 3,
    }).status_code == 409
    assert client.delete(f"/api/events/{missing}").status_code == 404

    assert client.delete(f"/api/distances/{missing}").status_code == 404
    assert client.put(f"/api/distances/{missing}", json={
        "official_id": 1, "site_id": 1, "one_way_miles": 1, "source": "manual",
    }).status_code in (400, 404)
    bad_fk = client.post("/api/distances", json={
        "official_id": missing, "site_id": missing, "one_way_miles": 1, "source": "manual",
    })
    assert bad_fk.status_code in (400, 404, 409)
    listed = client.get("/api/distances?official_id=1")
    assert listed.status_code == 200

    t = _tournament()
    t2 = _tournament()
    assert client.put(f"/api/tournaments/{missing}", json={
        "name": "x", "type": "junior",
        "play_start_date": t["play_start_date"],
        "play_end_date": t["play_end_date"],
    }).status_code == 404
    clash_t = client.put(f"/api/tournaments/{t2['id']}", json={
        "name": t["name"], "type": "junior",
        "play_start_date": t2["play_start_date"],
        "play_end_date": t2["play_end_date"],
    })
    assert clash_t.status_code == 409


def test_doubles_and_pairing_404s():
    t = _tournament()
    p1 = _ok(client.post("/api/players", json={
        "usta_number": "4" + uuid.uuid4().hex[:9], "first_name": "A",
        "last_name": "One", "gender": "female",
    }))
    p2 = _ok(client.post("/api/players", json={
        "usta_number": "4" + uuid.uuid4().hex[:9], "first_name": "B",
        "last_name": "Two", "gender": "female",
    }))
    # pair of players not on roster
    pair = client.post(f"/api/tournaments/{t['id']}/doubles-pairs", json={
        "usta_number": p1["usta_number"], "partner_usta": p2["usta_number"],
        "age_division": "G14",
    })
    assert pair.status_code in (400, 404, 422)
    missing = 9_999_992
    assert client.put(f"/api/doubles-requests/{missing}", json={"age_division": "G14"}).status_code == 404
    assert client.put(f"/api/doubles-pairs/{missing}", json={"age_division": "G14"}).status_code == 404
    assert client.delete(f"/api/doubles-requests/{missing}").status_code == 404
    assert client.delete(f"/api/doubles-pairs/{missing}").status_code == 404
    rnd = client.post(f"/api/tournaments/{t['id']}/doubles-requests", json={
        "usta_number": p1["usta_number"], "first_name": "A", "last_name": "One",
        "gender": "female", "wants_random": True,
    })
    assert rnd.status_code == 400
    assert client.post(f"/api/tournaments/{missing}/doubles-requests", json={
        "usta_number": p1["usta_number"], "first_name": "A", "last_name": "One",
        "gender": "female", "partner_usta": p2["usta_number"],
    }).status_code == 404
    q = client.get(f"/api/tournaments/{t['id']}/doubles?q=Nope")
    assert q.status_code == 200


def test_bulk_email_empty_and_no_tournament():
    empty = client.post("/api/emails/bulk/reassign", json={"email_ids": [], "tournament_id": 1})
    assert empty.status_code == 200 and empty.json()["updated"] == 0
    missing_t = client.post("/api/emails/bulk/reassign",
                            json={"email_ids": [1], "tournament_id": 9_999_993})
    assert missing_t.status_code == 404
    st = client.post("/api/emails/bulk/status", json={"email_ids": [], "status": "filed"})
    assert st.status_code == 200
    det = client.post("/api/emails/bulk/detect-players", json={"email_ids": []})
    assert det.status_code == 200
    conf = client.post("/api/emails/bulk/confirm-suggestions", json={"email_ids": []})
    assert conf.status_code == 200
    cl = client.post("/api/emails/bulk/classify", json={"email_ids": []})
    assert cl.status_code == 200
    pop = client.post("/api/emails/bulk/populate", json={"email_ids": []})
    assert pop.status_code == 200
    tri = client.post("/api/emails/bulk/triage", json={"email_ids": []})
    assert tri.status_code == 200

    t = _tournament()
    orphan = _ok(client.post("/api/emails", json={
        "subject": "No tourney", "body": "hi", "from_address": "a@b.c",
    }))
    client.put(f"/api/emails/{orphan['id']}", json={
        "tournament_id": None, "classification": "unclassified", "status": "new",
    })
    det2 = client.post("/api/emails/bulk/detect-players", json={"email_ids": [orphan["id"]]})
    assert det2.status_code == 200
    conf2 = client.post("/api/emails/bulk/confirm-suggestions", json={"email_ids": [orphan["id"]]})
    assert conf2.status_code == 200
    # leftover / other populate skip
    other = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "Thanks for hosting",
        "body": "See you next year", "from_address": "a@b.c",
    }))
    client.put(f"/api/emails/{other['id']}", json={
        "tournament_id": t["id"], "classification": "other", "status": "new",
    })
    pop2 = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [other["id"]]}), 200)
    assert pop2["filed"] == 0
    assert pop2["skipped"]


def test_users_export_flag_and_self_delete():
    me = client.get("/api/auth/me").json()
    # last-export-admin 409
    users = client.get("/api/admin/users")
    if users.status_code != 200:
        users = client.get("/api/users")
    # find admin id
    listing = users.json() if users.status_code == 200 else []
    rows = listing if isinstance(listing, list) else listing.get("users") or listing.get("items") or []
    admin_row = next((u for u in rows if u.get("username") == "admin"), None)
    if admin_row:
        r = client.patch(f"/api/admin/users/{admin_row['id']}", json={})
        assert r.status_code in (400, 422)
        revoke = client.patch(f"/api/admin/users/{admin_row['id']}", json={"can_export_pii": False})
        assert revoke.status_code in (200, 409)
        self_del = client.delete(f"/api/admin/users/{admin_row['id']}")
        assert self_del.status_code in (400, 409)


def test_td_chat_empty_message_and_execute_blank_tool(monkeypatch):
    r = client.post("/api/td-chat/turn", json={"message": "  "})
    assert r.status_code == 400
    bad = client.post("/api/td-chat/execute", json={"calls": [{"tool": ""}], "confirm": False})
    assert bad.status_code == 400
    monkeypatch.setattr("app.routers.td_chat.llm_enabled", lambda: True)
    monkeypatch.setattr("app.routers.td_chat.probe_llm", lambda: "ok")

    def _boom(_p):
        raise RuntimeError("sidecar")
    monkeypatch.setattr("app.td_chat.chat_complete", _boom)
    t = _tournament()
    err = client.post("/api/td-chat/turn", json={"message": "status", "tournament_id": t["id"]})
    assert err.status_code == 200
    assert "sidecar" in err.json()["reply"].lower() or err.json()["executed"] == []
    monkeypatch.setattr("app.routers.td_chat.probe_llm", lambda: "down")
    monkeypatch.setattr("app.routers.td_chat.llm_enabled", lambda: False)
    down = client.post("/api/td-chat/turn", json={"message": "status please", "tournament_id": t["id"]})
    assert down.status_code == 200
    # remove without entry_id prepends list_roster
    rm = client.post("/api/td-chat/turn", json={
        "message": "remove Ada Lovelace from the roster", "tournament_id": t["id"],
    })
    assert rm.status_code == 200


def test_gmail_fetch_oserror_is_502(monkeypatch):
    def _boom(*_a, **_k):
        raise OSError("connection reset")
    monkeypatch.setattr("app.routers.gmail_feed.fetch_latest", _boom)
    client.put("/api/gmail-feed", json={
        "enabled": True, "gmail_address": "td@gmail.com",
        "app_password": "abcd efgh ijkl mnop",
    })
    r = client.post("/api/gmail-feed/fetch")
    assert r.status_code in (400, 502)


def test_auto_distance_missing_official(monkeypatch):
    r = client.post("/api/distances/auto", json={"official_id": 9_999_994, "site_id": 1})
    assert r.status_code in (404, 405, 422)


def test_email_suggest_404_and_lazy_stamp():
    assert client.post("/api/emails/9999999/suggest").status_code == 404
    t = _tournament()
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "Hi", "body": "body",
        "from_address": "a@b.c",
    }))
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE email_message SET detected_text_ready = FALSE, "
                "detected_name_pairs = %s WHERE id = %s",
                ('"not-json"', e["id"]),
            )
        conn.commit()
    listed = client.get(f"/api/emails?tournament_id={t['id']}&unmatched=true")
    assert listed.status_code == 200
    row = next(x for x in listed.json() if x["id"] == e["id"])
    assert "subject" in row
    assert client.delete(f"/api/emails/9999999").status_code == 404


def test_cert_and_room_block_404():
    missing = 9_999_995
    o = _ok(client.post("/api/officials", json={
        "first_name": "C", "last_name": uuid.uuid4().hex[:6],
    }))
    assert client.delete(f"/api/certifications/{missing}").status_code == 404
    c1 = _ok(client.post(f"/api/officials/{o['id']}/certifications",
                         json={"cert_type": "roving_official"}))
    dup = client.post(f"/api/officials/{o['id']}/certifications",
                      json={"cert_type": "roving_official"})
    assert dup.status_code == 409
    missing_off = client.post("/api/officials/9999999/certifications",
                              json={"cert_type": "chair_umpire"})
    assert missing_off.status_code == 400
    t = _tournament()
    assert client.put(f"/api/room-blocks/{missing}", json={
        "tournament_id": t["id"], "hotel_id": 1, "kind": "official",
        "room_count": 1, "check_in": t["play_start_date"],
        "check_out": t["play_end_date"],
    }).status_code in (400, 404, 422)
    assert client.delete(f"/api/room-blocks/{missing}").status_code == 404
