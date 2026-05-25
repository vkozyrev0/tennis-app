"""End-to-end smoke tests for the CourtOps API (Phase 0 + Phase 1).

Requires a running, migrated + seeded Postgres (see backend/.env). The
assignment pay test relies on seeded certification rates (roving=150).
Run from backend/:  pytest
"""
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
# All admin endpoints require an admin session; conftest seeds admin/admin.
client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _db_up() -> bool:
    return client.get("/api/health").json().get("db") == "ok"


pytestmark = pytest.mark.skipif(
    not _db_up(), reason="Postgres not reachable / not migrated (run migrate.py)"
)


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _site(**kw):
    return _ok(client.post("/api/sites", json={"name": "S " + uuid.uuid4().hex[:6], **kw}))


def _tournament(**kw):
    body = {"name": "T " + uuid.uuid4().hex[:6], "type": "junior",
            "play_start_date": "2026-06-01", "play_end_date": "2026-06-04", **kw}
    return _ok(client.post("/api/tournaments", json=body))


def _official(**kw):
    return _ok(client.post("/api/officials",
                           json={"first_name": "F", "last_name": "L" + uuid.uuid4().hex[:5], **kw}))


def _player(**kw):
    return _ok(client.post("/api/players", json={"usta_number": "U" + uuid.uuid4().hex[:8], **kw}))


def _hotel(**kw):
    return _ok(client.post("/api/hotels", json={"name": "H " + uuid.uuid4().hex[:6], **kw}))


def test_health_ok():
    assert client.get("/api/health").json()["db"] == "ok"


def test_site_crud():
    s = _site(code="C" + uuid.uuid4().hex[:5], city="Atlanta", state="GA")
    r = client.put(f"/api/sites/{s['id']}", json={"name": "Edited", "city": "Macon"})
    assert r.status_code == 200 and r.json()["name"] == "Edited"
    assert client.delete(f"/api/sites/{s['id']}").status_code == 204
    assert client.get(f"/api/sites/{s['id']}").status_code == 404


def test_tournament_crud_and_dates():
    t = _tournament()
    assert t["id"]
    bad = client.post("/api/tournaments", json={
        "name": "bad " + uuid.uuid4().hex[:5], "type": "adult",
        "play_start_date": "2026-06-04", "play_end_date": "2026-06-01"})
    assert bad.status_code == 422


def test_tournament_sites_m2m():
    t = _tournament()
    s1, s2 = _site(), _site()
    r = client.put(f"/api/tournaments/{t['id']}/sites", json={"site_ids": [s1["id"], s2["id"]]})
    assert r.status_code == 200
    ids = {s["id"] for s in r.json()}
    assert ids == {s1["id"], s2["id"]}
    # replace with just one
    r = client.put(f"/api/tournaments/{t['id']}/sites", json={"site_ids": [s1["id"]]})
    assert [s["id"] for s in r.json()] == [s1["id"]]
    # unknown site rejected
    assert client.put(f"/api/tournaments/{t['id']}/sites",
                      json={"site_ids": [999999]}).status_code == 400


def test_official_and_player_crud():
    o = _official(dietary_restrictions="vegan")
    assert client.put(f"/api/officials/{o['id']}", json={"first_name": "F", "last_name": "Z"}).status_code == 200
    assert client.delete(f"/api/officials/{o['id']}").status_code == 204
    num = "U" + uuid.uuid4().hex[:8]
    p = _ok(client.post("/api/players", json={"usta_number": num}))
    assert client.post("/api/players", json={"usta_number": num}).status_code == 409
    assert client.delete(f"/api/players/{p['id']}").status_code == 204


def test_rate_crud():
    eff = f"1999-01-{uuid.uuid4().int % 28 + 1:02d}"
    r = _ok(client.post("/api/rates", json={"cert_type": "chair_umpire", "rate_per_day": 175.5, "effective_from": eff}))
    assert client.put(f"/api/rates/{r['id']}",
                      json={"cert_type": "chair_umpire", "rate_per_day": 180, "effective_from": eff}).status_code == 200
    assert client.delete(f"/api/rates/{r['id']}").status_code == 204


def test_hotel_and_room_block():
    h = _hotel(city="Macon", state="GA")
    t = _tournament()
    rb = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "room_count": 10,
        "check_in": "2026-05-31", "check_out": "2026-06-05", "confirmation_number": "X1"}))
    assert rb["room_count"] == 10 and rb["hotel_id"] == h["id"]
    # bad dates
    assert client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "check_in": "2026-06-05", "check_out": "2026-06-01"}).status_code == 422
    # bad hotel fk
    assert client.post("/api/room-blocks", json={"hotel_id": 999999}).status_code == 400
    assert client.put(f"/api/room-blocks/{rb['id']}",
                      json={"hotel_id": h["id"], "room_count": 12}).status_code == 200
    assert client.delete(f"/api/room-blocks/{rb['id']}").status_code == 204


def test_room_block_kind_filter():
    h, t = _hotel(), _tournament()
    client.post("/api/room-blocks", json={"hotel_id": h["id"], "tournament_id": t["id"], "kind": "official", "room_count": 3})
    client.post("/api/room-blocks", json={"hotel_id": h["id"], "tournament_id": t["id"], "kind": "player", "room_count": 5})
    off = client.get(f"/api/room-blocks?tournament_id={t['id']}&kind=official").json()
    assert len(off) == 1 and off[0]["kind"] == "official"
    allb = client.get(f"/api/room-blocks?tournament_id={t['id']}").json()
    assert len(allb) == 2


def test_distance_crud():
    o, s = _official(), _site()
    d = _ok(client.post("/api/distances", json={"official_id": o["id"], "site_id": s["id"], "one_way_miles": 80}))
    assert client.post("/api/distances", json={"official_id": o["id"], "site_id": s["id"], "one_way_miles": 90}).status_code == 409
    assert client.put(f"/api/distances/{d['id']}",
                      json={"official_id": o["id"], "site_id": s["id"], "one_way_miles": 85, "source": "geocoded"}).status_code == 200
    assert client.delete(f"/api/distances/{d['id']}").status_code == 204


def test_roster():
    t, p = _tournament(), _player()
    e = _ok(client.post(f"/api/tournaments/{t['id']}/players",
                        json={"player_id": p["id"], "age_division": "B14", "selection_status": "alternate"}))
    assert e["usta_number"] == p["usta_number"] and e["selection_status"] == "alternate"
    # duplicate player on same roster rejected
    assert client.post(f"/api/tournaments/{t['id']}/players", json={"player_id": p["id"]}).status_code == 409
    lst = client.get(f"/api/tournaments/{t['id']}/players").json()
    assert len(lst) == 1
    assert client.put(f"/api/roster/{e['id']}",
                      json={"player_id": p["id"], "selection_status": "selected"}).json()["selection_status"] == "selected"
    assert client.delete(f"/api/roster/{e['id']}").status_code == 204


def test_assignment_pay_and_mileage():
    t, o, s = _tournament(), _official(), _site()
    # distance: one-way 100 -> round trip 200 -> reimbursable 150 -> 150*0.65=97.5 (< cap)
    _ok(client.post("/api/distances", json={"official_id": o["id"], "site_id": s["id"], "one_way_miles": 100}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"], "site_id": s["id"]}))
    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    a = _ok(client.post(f"/api/assignments/{a['id']}/days", json={"work_date": today, "working_as": "roving_official"}))
    a = _ok(client.post(f"/api/assignments/{a['id']}/days", json={"work_date": tomorrow, "working_as": "chair_umpire"}))
    # seeded rates: roving 150, chair 200 -> pay 350
    assert a["pay"] == 350.0, a
    assert a["mileage"] == 97.5, a
    assert a["missing_distance"] is False
    assert a["total"] == 447.5
    # duplicate official on tournament rejected
    assert client.post(f"/api/tournaments/{t['id']}/assignments",
                       json={"official_id": o["id"]}).status_code == 409
    assert client.delete(f"/api/assignments/{a['id']}").status_code == 204


def test_roster_csv_import():
    t = _tournament()
    u1, u2 = "IMP" + uuid.uuid4().hex[:6], "IMP" + uuid.uuid4().hex[:6]
    csv_data = (
        "USTA #,First,Last,Division,T-Shirt,Status\n"
        f"{u1},Amy,Ace,G16,M,selected\n"
        f"{u2},Bob,Bell,B14,L,alternate\n"
    )
    r = client.post(f"/api/tournaments/{t['id']}/players/import",
                    files={"file": ("roster.csv", csv_data, "text/csv")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["entries"] == 2 and body["created_players"] == 2
    roster = client.get(f"/api/tournaments/{t['id']}/players").json()
    assert sorted(e["usta_number"] for e in roster) == sorted([u1, u2])
    assert {e["selection_status"] for e in roster} == {"selected", "alternate"}
    # re-import is an upsert (no duplicate rows), and updates the name
    r2 = client.post(f"/api/tournaments/{t['id']}/players/import",
                     files={"file": ("roster.csv", csv_data.replace("Amy", "Amelia"), "text/csv")})
    assert r2.json()["entries"] == 2
    roster2 = client.get(f"/api/tournaments/{t['id']}/players").json()
    assert len(roster2) == 2
    amy = next(e for e in roster2 if e["usta_number"] == u1)
    assert amy["first_name"] == "Amelia"


def test_room_count_enforced():
    t = _tournament()
    h = _hotel()
    blk = _ok(client.post("/api/room-blocks",
                          json={"hotel_id": h["id"], "tournament_id": t["id"], "room_count": 1}))
    o1, o2 = _official(), _official()
    _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                    json={"official_id": o1["id"], "room_block_id": blk["id"]}))
    r = client.post(f"/api/tournaments/{t['id']}/assignments",
                    json={"official_id": o2["id"], "room_block_id": blk["id"]})
    assert r.status_code == 409, r.text  # block full
    blocks = client.get(f"/api/room-blocks?tournament_id={t['id']}").json()
    assert blocks[0]["rooms_remaining"] == 0


def test_pay_snapshot_persisted():
    t = _tournament()
    o = _official()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    assert a["rule_version"] and a["snapshot_at"]  # snapshotted on create
    a2 = _ok(client.post(f"/api/assignments/{a['id']}/days",
                         json={"work_date": "2026-06-01", "working_as": "roving_official"}), 201)
    assert a2["pay"] == 150.0 and a2["snapshot_at"]
    # persisted: list endpoint returns the stored rule_version
    row = next(x for x in client.get(f"/api/tournaments/{t['id']}/assignments").json() if x["id"] == a["id"])
    assert row["rule_version"] == a2["rule_version"]


def test_triage_suggest():
    t = _tournament()
    cases = [
        ("Need to withdraw", "my child has an injury", "withdrawal"),
        ("Late entry?", "we missed the deadline, can we still enter", "late_entry"),
        ("Doubles partner", "please set up random pairing", "doubles"),
        ("Hotel info", "we are staying at the Marriott", "hotel"),
    ]
    for subj, body, expected in cases:
        em = _ok(client.post("/api/emails", json={"tournament_id": t["id"], "subject": subj, "body": body}))
        got = client.post(f"/api/emails/{em['id']}/suggest").json()["classification"]
        assert got == expected, f"{subj!r} -> {got}, expected {expected}"


def test_inbox_and_late_entry_filing():
    t = _tournament()
    em = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "from_address": "parent@x.com",
        "subject": "Late entry please", "body": "Can my child still enter?"}))
    assert em["status"] == "new" and em["classification"] == "unclassified"
    assert any(m["id"] == em["id"] for m in client.get(f"/api/emails?tournament_id={t['id']}").json())

    num = "LATE" + uuid.uuid4().hex[:6]
    le = _ok(client.post(f"/api/tournaments/{t['id']}/late-entries", json={
        "usta_number": num, "first_name": "Lee", "last_name": "Tardy",
        "age_division": "B16", "events": "Singles", "request_date": "2026-05-30",
        "source_email_id": em["id"]}))
    assert le["usta_number"] == num and le["player_id"]
    # filing marked the source email filed + classified
    em2 = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json() if m["id"] == em["id"])
    assert em2["status"] == "filed" and em2["classification"] == "late_entry"
    # the player landed on the roster (source=late_entry)
    assert any(e["usta_number"] == num for e in client.get(f"/api/tournaments/{t['id']}/players").json())
    assert len(client.get(f"/api/tournaments/{t['id']}/late-entries").json()) == 1
    assert client.delete(f"/api/late-entries/{le['id']}").status_code == 204


def test_withdrawal_reason_rule_and_roster_flip():
    t, p = _tournament(), _player()
    # selected player: reason required
    client.post(f"/api/tournaments/{t['id']}/players", json={"player_id": p["id"], "selection_status": "selected"})
    no_reason = client.post(f"/api/tournaments/{t['id']}/withdrawals", json={"usta_number": p["usta_number"]})
    assert no_reason.status_code == 400, no_reason.text
    w = _ok(client.post(f"/api/tournaments/{t['id']}/withdrawals",
                        json={"usta_number": p["usta_number"], "reason": "injury", "events": "Singles"}))
    assert w["reason"] == "injury" and w["was_alternate"] is False
    # roster flipped to withdrawn
    entry = next(e for e in client.get(f"/api/tournaments/{t['id']}/players").json() if e["usta_number"] == p["usta_number"])
    assert entry["selection_status"] == "withdrawn"
    assert client.delete(f"/api/withdrawals/{w['id']}").status_code == 204


def test_withdrawal_alternate_needs_no_reason():
    t, p = _tournament(), _player()
    client.post(f"/api/tournaments/{t['id']}/players", json={"player_id": p["id"], "selection_status": "alternate"})
    w = _ok(client.post(f"/api/tournaments/{t['id']}/withdrawals", json={"usta_number": p["usta_number"]}))
    assert w["was_alternate"] is True and (w["reason"] is None or w["reason"] == "")


def test_doubles_mutual_verification():
    t = _tournament()
    a, b = _player(), _player()
    # first email (A names B): pending, no pair yet
    r1 = _ok(client.post(f"/api/tournaments/{t['id']}/doubles-requests", json={
        "usta_number": a["usta_number"], "age_division": "G14", "partner_usta": b["usta_number"]}))
    assert r1["paired"] is False
    assert len(client.get(f"/api/tournaments/{t['id']}/doubles").json()["pairs"]) == 0
    # second email (B names A): verifies the partnership
    r2 = _ok(client.post(f"/api/tournaments/{t['id']}/doubles-requests", json={
        "usta_number": b["usta_number"], "age_division": "G14", "partner_usta": a["usta_number"]}))
    assert r2["paired"] is True
    data = client.get(f"/api/tournaments/{t['id']}/doubles").json()
    assert len(data["pairs"]) == 1 and data["pairs"][0]["pairing_type"] == "mutual"
    assert all(req["status"] == "paired" for req in data["requests"])


def test_doubles_random_queue():
    t = _tournament()
    a, b = _player(), _player()
    # first random: queued (waiting)
    r1 = _ok(client.post(f"/api/tournaments/{t['id']}/doubles-requests",
                         json={"usta_number": a["usta_number"], "age_division": "B16", "wants_random": True}))
    assert r1["paired"] is False
    # second random same division: pairs FIFO
    r2 = _ok(client.post(f"/api/tournaments/{t['id']}/doubles-requests",
                         json={"usta_number": b["usta_number"], "age_division": "B16", "wants_random": True}))
    assert r2["paired"] is True
    data = client.get(f"/api/tournaments/{t['id']}/doubles").json()
    assert len(data["pairs"]) == 1 and data["pairs"][0]["pairing_type"] == "random"
    # mutual request requires a partner (or random)
    bad = client.post(f"/api/tournaments/{t['id']}/doubles-requests", json={"usta_number": a["usta_number"]})
    assert bad.status_code == 422


def test_pairing_avoidance_group():
    t = _tournament()
    p1, p2 = _player(), _player()
    g = _ok(client.post(f"/api/tournaments/{t['id']}/pairing-avoidances", json={
        "age_division": "B12", "relationship": "siblings",
        "members": [{"usta_number": p1["usta_number"], "last_name": "A"},
                    {"usta_number": p2["usta_number"], "last_name": "B"}]}))
    assert g["relationship"] == "siblings" and len(g["members"]) == 2
    # fewer than two players rejected
    bad = client.post(f"/api/tournaments/{t['id']}/pairing-avoidances",
                      json={"relationship": "same_club", "members": [{"usta_number": p1["usta_number"]}]})
    assert bad.status_code == 422
    assert len(client.get(f"/api/tournaments/{t['id']}/pairing-avoidances").json()) == 1
    assert client.delete(f"/api/pairing-avoidances/{g['id']}").status_code == 204


def test_player_hotels_analytics_and_tshirts():
    t, p = _tournament(), _player()
    hname = "Marriott " + uuid.uuid4().hex[:4]
    s = _ok(client.post(f"/api/tournaments/{t['id']}/player-hotels",
                        json={"usta_number": p["usta_number"], "hotel_name": hname}))
    assert s["hotel_name"] == hname
    # CVB analytics aggregates this hotel
    totals = client.get("/api/hotel-analytics").json()
    assert any(r["hotel_name"] == hname and r["stays"] >= 1 for r in totals)
    assert client.delete(f"/api/player-hotels/{s['id']}").status_code == 204

    # t-shirt cumulative list picks up a roster entry's size
    p2 = _player()
    client.post(f"/api/tournaments/{t['id']}/players",
                json={"player_id": p2["id"], "age_division": "G12", "t_shirt_size": "YM"})
    shirts = client.get("/api/tshirts").json()
    assert any(r["usta_number"] == p2["usta_number"] and r["t_shirt_size"] == "YM" for r in shirts)


def test_scheduling_and_division_lists():
    t, p = _tournament(), _player()
    sa = _ok(client.post(f"/api/tournaments/{t['id']}/scheduling-avoidances",
                         json={"usta_number": p["usta_number"], "avoid_day": "Sat", "avoid_time_range": "before 10am"}))
    assert sa["avoid_day"] == "Sat" and sa["usta_number"] == p["usta_number"]
    assert len(client.get(f"/api/tournaments/{t['id']}/scheduling-avoidances").json()) == 1
    assert client.delete(f"/api/scheduling-avoidances/{sa['id']}").status_code == 204
    df = _ok(client.post(f"/api/tournaments/{t['id']}/division-flex",
                         json={"usta_number": p["usta_number"], "home_division": "4.0", "willing_divisions": "4.5,5.0"}))
    assert df["willing_divisions"] == "4.5,5.0"
    assert client.delete(f"/api/division-flex/{df['id']}").status_code == 204


def test_auth_gating_and_official_self_service():
    anon = TestClient(app)  # no session
    assert anon.get("/api/sites").status_code == 401          # admin gated
    assert anon.get("/api/me").status_code == 401             # needs login
    assert anon.post("/api/auth/login", json={"username": "admin", "password": "nope"}).status_code == 401

    # admin creates an official + a login for them
    o = _official(first_name="Self", last_name="Serve")
    uname = "off" + uuid.uuid4().hex[:6]
    acct = client.put(f"/api/officials/{o['id']}/account", json={"username": uname, "password": "pw123"})
    assert acct.status_code == 200, acct.text

    # official logs in (fresh client) and can use /api/me but NOT admin routes
    off = TestClient(app)
    assert off.post("/api/auth/login", json={"username": uname, "password": "pw123"}).json()["role"] == "official"
    assert off.get("/api/sites").status_code == 403          # admin only
    me = off.get("/api/me").json()
    assert me["official"]["id"] == o["id"]
    upd = off.put("/api/me/profile", json={"first_name": "Self", "last_name": "Serve", "phone": "555-9"})
    assert upd.status_code == 200 and upd.json()["phone"] == "555-9"

    # official sets own availability for a tournament
    t = _tournament()
    off.put(f"/api/me/availability/{t['id']}", json={"dates": ["2026-06-01"], "hotel_needed": True})
    got = off.get(f"/api/me/availability/{t['id']}").json()
    assert got["dates"] == ["2026-06-01"] and got["hotel_needed"] is True
    # and the admin availability view sees it
    rows = client.get(f"/api/tournaments/{t['id']}/availability").json()
    assert any(r["official_id"] == o["id"] for r in rows)


def test_certifications_and_role_guard():
    o = _official()
    # add a chair certification
    c = _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "chair_umpire"}))
    assert c["cert_type"] == "chair_umpire"
    assert client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "chair_umpire"}).status_code == 409
    certs = client.get(f"/api/officials/{o['id']}/certifications").json()
    assert [x["cert_type"] for x in certs] == ["chair_umpire"]

    # assignment day as a role they DON'T hold is rejected; one they hold is allowed
    t = _tournament()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    bad = client.post(f"/api/assignments/{a['id']}/days", json={"work_date": "2026-06-01", "working_as": "tournament_referee"})
    assert bad.status_code == 409, bad.text
    ok = client.post(f"/api/assignments/{a['id']}/days", json={"work_date": "2026-06-01", "working_as": "chair_umpire"})
    assert ok.status_code == 201, ok.text
    assert client.delete(f"/api/certifications/{c['id']}").status_code == 204


def test_availability_set_and_list():
    t = _tournament()
    o = _official()
    r = client.put(f"/api/tournaments/{t['id']}/availability",
                   json={"official_id": o["id"], "dates": ["2026-06-01", "2026-06-02"], "hotel_needed": True})
    assert r.status_code == 200, r.text
    rows = client.get(f"/api/tournaments/{t['id']}/availability").json()
    assert sorted(x["available_date"] for x in rows) == ["2026-06-01", "2026-06-02"]
    assert all(x["hotel_needed"] for x in rows)
    # PUT replaces (idempotent set semantics)
    client.put(f"/api/tournaments/{t['id']}/availability",
               json={"official_id": o["id"], "dates": ["2026-06-03"], "hotel_needed": False})
    rows2 = client.get(f"/api/tournaments/{t['id']}/availability").json()
    assert [x["available_date"] for x in rows2] == ["2026-06-03"]


def test_officials_report_totals():
    t = _tournament()
    o = _official(dietary_restrictions="vegan")
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    # one roving day -> seeded roving rate = 150
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-01", "working_as": "roving_official"}))
    rep = _ok(client.get(f"/api/tournaments/{t['id']}/reports/officials"), 200)
    assert rep["totals"]["official_count"] == 1
    assert rep["totals"]["pay"] == 150.0
    assert rep["totals"]["total"] == 150.0  # no site -> no mileage
    assert rep["officials"][0]["dietary_restrictions"] == "vegan"
    assert rep["officials"][0]["days"][0]["working_as"] == "roving_official"


def test_player_history_capture():
    p = _player(first_name="A", last_name="Before")
    r = client.put(f"/api/players/{p['id']}", json={"usta_number": p["usta_number"], "first_name": "A", "last_name": "After"})
    assert r.status_code == 200 and r.json()["last_name"] == "After"
    hist = client.get(f"/api/players/{p['id']}/history").json()
    assert len(hist) >= 1
    assert hist[0]["last_name"] == "Before" and hist[0]["change_type"] == "update"
    # delete keeps the audit row (no FK on player_history)
    assert client.delete(f"/api/players/{p['id']}").status_code == 204
    after_del = client.get(f"/api/players/{p['id']}/history").json()
    assert any(h["change_type"] == "delete" for h in after_del)


def test_roster_point_in_time_name():
    from app.db import get_conn
    p = _player(first_name="A", last_name="Maiden")
    # backdate the current version so it is valid from 2024 (updated_at is not a
    # tracked field, so this does not create a history row by itself)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE player SET updated_at = '2024-01-01' WHERE id = %s", (p["id"],))
        conn.commit()
    finally:
        conn.close()
    # rename -> history row 'Maiden' valid [2024-01-01, now); current 'Married'
    client.put(f"/api/players/{p['id']}", json={"usta_number": p["usta_number"], "first_name": "A", "last_name": "Married"})

    t_old = _tournament(play_start_date="2024-06-01", play_end_date="2024-06-03")
    t_new = _tournament(play_start_date="2027-06-01", play_end_date="2027-06-03")
    client.post(f"/api/tournaments/{t_old['id']}/players", json={"player_id": p["id"]})
    client.post(f"/api/tournaments/{t_new['id']}/players", json={"player_id": p["id"]})

    old_name = client.get(f"/api/tournaments/{t_old['id']}/players").json()[0]["last_name"]
    new_name = client.get(f"/api/tournaments/{t_new['id']}/players").json()[0]["last_name"]
    assert old_name == "Maiden", f"expected as-of-2024 name, got {old_name}"
    assert new_name == "Married", f"expected current name, got {new_name}"


def test_assignment_missing_distance_and_hotel_mismatch():
    t, o, s, h = _tournament(), _official(), _site(), _hotel()
    # no distance on file -> mileage None, missing_distance True
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"], "site_id": s["id"]}))
    a = _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": date.today().isoformat(), "working_as": "tournament_referee"}))
    assert a["mileage"] is None and a["missing_distance"] is True
    # room block whose window excludes today -> hotel_date_mismatch True
    future = (date.today() + timedelta(days=10)).isoformat()
    rb = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "room_count": 5,
        "check_in": future, "check_out": future}))
    a = client.put(f"/api/assignments/{a['id']}",
                   json={"official_id": o["id"], "site_id": s["id"], "room_block_id": rb["id"]}).json()
    assert a["hotel_date_mismatch"] is True, a
    assert client.delete(f"/api/assignments/{a['id']}").status_code == 204
