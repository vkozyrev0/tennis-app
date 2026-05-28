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
    # gender + birthdate are required on /api/players; default both so tests
    # that don't care about them stay terse. Override via kw when needed.
    return _ok(client.post("/api/players", json={
        "usta_number": "U" + uuid.uuid4().hex[:8],
        "gender": "female", "birthdate": "2010-01-01", **kw}))


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
    p = _ok(client.post("/api/players", json={"usta_number": num, "gender": "female", "birthdate": "2010-01-01"}))
    assert client.post("/api/players", json={"usta_number": num, "gender": "female", "birthdate": "2010-01-01"}).status_code == 409
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


def test_roster_inline_create_player():
    """The roster +New form lets a TD enter a walk-in player by USTA # alone;
    the backend upserts via player_ops, no need to pre-create in Setup. The
    gender is carried through so the picker shows the right division list."""
    t = _tournament()
    num = "WALKIN" + uuid.uuid4().hex[:6]
    e = _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "usta_number": num, "first_name": "Walter", "last_name": "Inn",
        "gender": "male", "age_division": "B16", "selection_status": "selected",
    }))
    assert e["usta_number"] == num and e["first_name"] == "Walter"
    # The new player picked up the gender we sent through the inline-create path.
    pl = next(p for p in client.get("/api/players").json() if p["usta_number"] == num)
    assert pl["gender"] == "male"
    # neither id nor usta_number → 422
    r = client.post(f"/api/tournaments/{t['id']}/players", json={"age_division": "B14"})
    assert r.status_code == 422, r.text


def test_divisions_events_catalog():
    """Seed populates junior + adult divisions and events; CRUD round-trips."""
    divs = client.get("/api/divisions").json()
    codes = {d["code"] for d in divs}
    # spot-check the seed
    assert {"B10", "G18", "NTRP 3.0 Men", "NTRP Open Women", "Combo 6.0"} <= codes
    juniors = client.get("/api/divisions?tournament_type=junior").json()
    assert {d["code"] for d in juniors} >= {"B12", "G16"}
    assert all(d["tournament_type"] == "junior" for d in juniors)
    evts = client.get("/api/events").json()
    names = {e["name"] for e in evts}
    assert {"Singles", "Doubles", "Men's Singles", "Mixed Doubles"} <= names

    # Create a custom division, edit it, delete it.
    code = "CUSTOM" + uuid.uuid4().hex[:4]
    d = _ok(client.post("/api/divisions", json={
        "code": code, "label": "Custom Division", "tournament_type": "adult",
        "gender": "male", "sort_order": 999}))
    assert d["code"] == code and d["gender"] == "male"
    upd = _ok(client.put(f"/api/divisions/{d['id']}", json={
        **d, "label": "Custom Updated"}), 200)
    assert upd["label"] == "Custom Updated"
    # duplicate code → 409
    dup = client.post("/api/divisions", json={
        "code": code, "label": "x", "tournament_type": "adult", "gender": "male"})
    assert dup.status_code == 409
    assert client.delete(f"/api/divisions/{d['id']}").status_code == 204


def test_player_gender_required_and_constraint():
    """gender is required (Pydantic Literal + NOT NULL); accepts male/female only."""
    p = _ok(client.post("/api/players", json={
        "usta_number": "GEN" + uuid.uuid4().hex[:6], "first_name": "G", "last_name": "Test",
        "gender": "female", "birthdate": "2010-01-01"}))
    assert p["gender"] == "female"
    upd = _ok(client.put(f"/api/players/{p['id']}",
                         json={**p, "gender": "male"}), 200)
    assert upd["gender"] == "male"
    # null gender → 422 (Pydantic required)
    nulled = client.put(f"/api/players/{p['id']}", json={**p, "gender": None})
    assert nulled.status_code == 422
    # missing gender field → 422 (required)
    no_gender = client.post("/api/players", json={"usta_number": "MISSING" + uuid.uuid4().hex[:4], "birthdate": "2010-01-01"})
    assert no_gender.status_code == 422
    # Audit N3: birthdate is optional at the API boundary (inline-create from
    # roster + inbox flows don't have one) — Setup form still has HTML-side
    # `required`, but the model accepts None.
    no_bd = client.post("/api/players", json={
        "usta_number": "NOBD" + uuid.uuid4().hex[:4], "gender": "female"})
    assert no_bd.status_code == 201
    # bad value → 422 (Literal)
    bad = client.put(f"/api/players/{p['id']}", json={**p, "gender": "nonbinary"})
    assert bad.status_code == 422


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
        "USTA #,First,Last,Gender,Division,T-Shirt,Status\n"
        f"{u1},Amy,Ace,F,G16,M,selected\n"
        f"{u2},Bob,Bell,M,B14,L,alternate\n"
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


def test_player_put_optimistic_concurrency():
    """Audit M19: a PUT with a stale `X-If-Updated-At` header is rejected."""
    p = _player(first_name="Conc", last_name="Race")
    first_ts = p["updated_at"]
    # Update once — bumps updated_at via the player_history trigger.
    upd = _ok(client.put(f"/api/players/{p['id']}",
                         json={**p, "city": "Atlanta"}), 200)
    assert upd["updated_at"] != first_ts
    # Now another tab tries to write with the *original* timestamp → 409.
    stale = client.put(
        f"/api/players/{p['id']}",
        json={**p, "city": "Macon"},
        headers={"X-If-Updated-At": first_ts},
    )
    assert stale.status_code == 409, stale.text
    # Sending the current timestamp succeeds.
    fresh = client.put(
        f"/api/players/{p['id']}",
        json={**upd, "city": "Macon"},
        headers={"X-If-Updated-At": upd["updated_at"]},
    )
    assert fresh.status_code == 200


def test_roster_import_requires_gender_for_new_players():
    """Audit C1: roster CSV must carry gender for any new player it creates."""
    t = _tournament()
    u_new = "GENNEW" + uuid.uuid4().hex[:6]
    # Existing player already has a gender — no need to send one for the update.
    existing = _player(first_name="Old", last_name="Hat")
    csv_data = (
        "USTA #,First,Last\n"
        f"{u_new},New,Player\n"           # missing gender → rejected
        f"{existing['usta_number']},Old,Hat\n"  # existing → OK
    )
    r = _ok(client.post(f"/api/tournaments/{t['id']}/players/import",
                        files={"file": ("roster.csv", csv_data, "text/csv")}), 200)
    assert r["created_players"] == 0
    # After consolidating on playerops.upsert_player, the error wording matches
    # the inbox flows ("isn't in Setup → Players yet").
    assert any("Setup" in e and "gender" in e for e in r["errors"])
    assert r["entries"] == 1  # only the existing player was rostered


def test_roster_import_normalizes_tshirt_sizes():
    t = _tournament()
    ids = ["TS" + uuid.uuid4().hex[:6] for _ in range(5)]
    csv_data = "USTA #,First,Gender,T-Shirt\n" + "".join(
        f"{i},N,F,{sz}\n" for i, sz in zip(ids, ["YM", "Adult Large", "xl", "youth small", "AS"])
    )
    r = client.post(f"/api/tournaments/{t['id']}/players/import",
                    files={"file": ("roster.csv", csv_data, "text/csv")})
    assert r.status_code == 200, r.text
    roster = {e["usta_number"]: e["t_shirt_size"] for e in
              client.get(f"/api/tournaments/{t['id']}/players").json()}
    assert roster[ids[0]] == "Youth Medium"
    assert roster[ids[1]] == "Adult Large"
    assert roster[ids[2]] == "Adult Extra Large"
    assert roster[ids[3]] == "Youth Small"
    assert roster[ids[4]] == "Adult Small"


def test_player_city_state():
    p = _ok(client.post("/api/players", json={
        "usta_number": "CS" + uuid.uuid4().hex[:6], "gender": "female",
        "birthdate": "2010-01-01", "city": "Atlanta", "state": "GA"}))
    assert p["city"] == "Atlanta" and p["state"] == "GA"
    upd = client.put(f"/api/players/{p['id']}", json={
        "usta_number": p["usta_number"], "gender": "female", "birthdate": "2010-01-01",
        "city": "Macon", "state": "GA"}).json()
    assert upd["city"] == "Macon"


def test_import_staging_and_merge():
    t = _tournament()
    ids = ["IS" + uuid.uuid4().hex[:6] for _ in range(3)]
    # one valid, one valid, one invalid (missing USTA #). Audit N1: gender is
    # required when creating a new player.
    csv_data = ("USTA #,First,Gender,Division,T-Shirt\n"
                f"{ids[0]},Ann,F,G12,YM\n"
                f"{ids[1]},Bea,F,G14,Adult Large\n"
                ",NoUsta,F,G16,AS\n")
    up = client.post(f"/api/import/tournaments/{t['id']}/roster",
                     files={"file": ("roster.csv", csv_data, "text/csv")})
    assert up.status_code == 201, up.text
    b = up.json()
    assert b["total"] == 3 and b["valid"] == 2 and b["invalid"] == 1
    # nothing in the roster yet — staged only
    assert client.get(f"/api/tournaments/{t['id']}/players").json() == []
    # merge → only the 2 valid rows land, sizes normalized
    m = client.post(f"/api/import/batches/{b['batch_id']}/merge").json()
    assert m["merged"] == 2 and m["failed"] == 0
    roster = {e["usta_number"]: e for e in client.get(f"/api/tournaments/{t['id']}/players").json()}
    assert set(roster) == {ids[0], ids[1]}
    assert roster[ids[0]]["t_shirt_size"] == "Youth Medium"
    # re-importing the same players is a conflict (merged anyway, but reported)
    up2 = client.post(f"/api/import/tournaments/{t['id']}/roster",
                      files={"file": ("roster.csv", csv_data, "text/csv")}).json()
    m2 = client.post(f"/api/import/batches/{up2['batch_id']}/merge").json()
    assert m2["merged"] == 2 and len(m2["conflicts"]) == 2
    assert "roster" in m2["conflicts"][0]["detail"]
    # templates download in both formats
    assert client.get("/api/import/template/roster?fmt=csv").status_code == 200
    assert client.get("/api/import/template/roster?fmt=xlsx").status_code == 200
    # Audit import/export #4 + #10: every importer type has a downloadable
    # template that round-trips through validate + merge. Catches a future
    # registry entry that forgets a column or whose merge function disagrees
    # with the template's header names.
    types = {x["key"]: x for x in client.get("/api/import/types").json()}
    assert types.keys() >= {
        "roster", "late_entries", "withdrawals", "scheduling_avoidances",
        "division_flexibility", "player_hotels", "distances",
        "pairing_avoidances", "doubles_requests",
    }
    for key in types:
        csv_t = client.get(f"/api/import/template/{key}?fmt=csv")
        assert csv_t.status_code == 200, key
        xlsx_t = client.get(f"/api/import/template/{key}?fmt=xlsx")
        assert xlsx_t.status_code == 200, key
        # Template headers cover every canonical column the registry declares
        # (header order matches `cols`); the importer's parse_file uses these
        # names as the alias map's "canon" key, so an upload of the template
        # itself parses cleanly even when it has zero data rows.
        header_line = csv_t.content.decode("utf-8-sig").splitlines()[0]
        assert set(header_line.split(",")) == set(types[key]["columns"]), key


def test_import_merge_per_type_smoke():
    """Audit import/export #4: every Part-B importer can stage + merge a
    synthetic single-row CSV without raising. Catches a future merge fn that
    breaks against its own template (column-name drift, missing INSERT col)."""
    t = _tournament()
    # Need a pre-existing player in Setup for inbox flows that refuse new
    # players without a gender (audit N1).
    p_a = _player(first_name="Aa", last_name="Bb")
    p_b = _player(first_name="Cc", last_name="Dd", gender="male")
    # Pre-roster for doubles (audit F15 requires entries on tournament_entry).
    for p in (p_a, p_b):
        client.post(f"/api/tournaments/{t['id']}/players",
                    json={"player_id": p["id"], "selection_status": "selected"})
    # Per-type synthetic rows. roster is already exercised; skip here.
    rows_by_type = {
        "late_entries": f"usta_number,age_division,events\n{p_a['usta_number']},G14,Singles\n",
        "withdrawals": f"usta_number,reason\n{p_a['usta_number']},Injured\n",
        "scheduling_avoidances": f"usta_number,avoid_day,avoid_time_range\n{p_a['usta_number']},Saturday,morning\n",
        "division_flexibility": f"usta_number,home_division,willing_divisions\n{p_a['usta_number']},NTRP 3.5,NTRP 4.0\n",
        "player_hotels": f"usta_number,hotel_name,lodging_plan\n{p_a['usta_number']},Marriott Demo,Hotel\n",
        "pairing_avoidances": f"usta_1,usta_2,age_division,relationship\n{p_a['usta_number']},{p_b['usta_number']},B12,siblings\n",
        "doubles_requests": f"usta_number,age_division,wants_random,partner_usta\n{p_a['usta_number']},G14,false,{p_b['usta_number']}\n",
    }
    # Track which types are expected to produce a conflict-note when re-merged
    # (their `_exists` branch fires). Doubles uniquely uses a separate
    # `pending` status path, but a duplicate request still annotates.
    conflict_expected = {
        "late_entries", "withdrawals", "scheduling_avoidances",
        "division_flexibility", "player_hotels", "doubles_requests",
    }
    for key, csv_data in rows_by_type.items():
        up = client.post(f"/api/import/tournaments/{t['id']}/{key}",
                         files={"file": (f"{key}.csv", csv_data, "text/csv")})
        assert up.status_code == 201, f"{key}: {up.text}"
        b = up.json()
        assert b["valid"] == 1 and b["invalid"] == 0, f"{key} staging: {b}"
        m = client.post(f"/api/import/batches/{b['batch_id']}/merge").json()
        assert m["merged"] == 1, f"{key} merge: {m}"
        assert m["failed"] == 0, f"{key} failed: {m}"
        # Fifth-pass #6: re-merge the same row to exercise the conflict path.
        if key in conflict_expected:
            up2 = client.post(f"/api/import/tournaments/{t['id']}/{key}",
                              files={"file": (f"{key}.csv", csv_data, "text/csv")})
            assert up2.status_code == 201, f"{key} re-stage: {up2.text}"
            m2 = client.post(f"/api/import/batches/{up2.json()['batch_id']}/merge").json()
            assert m2["merged"] == 1, f"{key} re-merge: {m2}"
            assert len(m2["conflicts"]) >= 1, f"{key} expected conflict note, got {m2}"


def test_import_doubles_new_player_with_gender():
    """Sixth-pass: a doubles_requests CSV with a never-seen `usta_number` plus
    a `gender` column passes staging (gender-escape-hatch in validate()) AND
    successfully creates the player at merge time. Was a regression where
    `_merge_doubles` dropped the gender arg into upsert_player."""
    t = _tournament()
    # Pre-existing partner for the mutual flow.
    partner = _player(first_name="Pre", last_name="Made", gender="male")
    client.post(f"/api/tournaments/{t['id']}/players",
                json={"player_id": partner["id"], "selection_status": "selected"})
    new_usta = "DOUB" + uuid.uuid4().hex[:6]
    # The new player must also be on the roster for _make_pair, but doubles
    # requests don't require it. Just exercise the create path.
    csv_data = (
        "usta_number,first_name,last_name,gender,age_division,wants_random,partner_usta\n"
        f"{new_usta},Brand,New,female,G14,false,{partner['usta_number']}\n"
    )
    up = _ok(client.post(f"/api/import/tournaments/{t['id']}/doubles_requests",
                         files={"file": ("d.csv", csv_data, "text/csv")}))
    assert up["valid"] == 1 and up["invalid"] == 0, up
    m = client.post(f"/api/import/batches/{up['batch_id']}/merge").json()
    assert m["merged"] == 1 and m["failed"] == 0, m
    # Player exists in Setup with the gender we sent.
    pl = next((p for p in client.get("/api/players").json() if p["usta_number"] == new_usta), None)
    assert pl is not None and pl["gender"] == "female"


def test_import_distances_setup_catalog():
    """Audit import/export #7: distance Setup catalog importer resolves
    official + site by ids OR by labels, updates existing pairs."""
    t = _tournament()  # body endpoint requires a tournament context even though distances are global
    o = _official(first_name="Imp", last_name="Driver" + uuid.uuid4().hex[:4])
    s = _site(code="IMPS" + uuid.uuid4().hex[:3], name="Imp Site")
    # First import by labels (last_name + site_code).
    csv1 = f"last_name,first_name,site_code,one_way_miles\n{o['last_name']},{o['first_name']},{s['code']},42.5\n"
    up = _ok(client.post(f"/api/import/tournaments/{t['id']}/distances",
                         files={"file": ("d.csv", csv1, "text/csv")}))
    m = client.post(f"/api/import/batches/{up['batch_id']}/merge").json()
    assert m["merged"] == 1, m
    # Find the new row and verify the value.
    rows = client.get("/api/distances").json()
    found = [r for r in rows if r["official_id"] == o["id"] and r["site_id"] == s["id"]]
    assert len(found) == 1 and float(found[0]["one_way_miles"]) == 42.5
    # Second import by ids overwrites (conflict note expected).
    csv2 = f"official_id,site_id,one_way_miles,source\n{o['id']},{s['id']},60,geocoded\n"
    up2 = _ok(client.post(f"/api/import/tournaments/{t['id']}/distances",
                          files={"file": ("d2.csv", csv2, "text/csv")}))
    m2 = client.post(f"/api/import/batches/{up2['batch_id']}/merge").json()
    assert m2["merged"] == 1 and len(m2["conflicts"]) == 1
    rows = client.get("/api/distances").json()
    found = [r for r in rows if r["official_id"] == o["id"] and r["site_id"] == s["id"]]
    assert float(found[0]["one_way_miles"]) == 60 and found[0]["source"] == "geocoded"


def test_player_hotel_fk_dedup():
    t, p1, p2 = _tournament(), _player(), _player()
    hname = "Grand Hyatt " + uuid.uuid4().hex[:4]
    s1 = _ok(client.post(f"/api/tournaments/{t['id']}/player-hotels",
                         json={"usta_number": p1["usta_number"], "hotel_name": hname}))
    # same hotel, messy casing/spacing → same hotel_id + canonical name
    s2 = _ok(client.post(f"/api/tournaments/{t['id']}/player-hotels",
                         json={"usta_number": p2["usta_number"], "hotel_name": f"  {hname.lower()}   "}))
    assert s1["hotel_id"] and s1["hotel_id"] == s2["hotel_id"]
    assert s1["hotel_name"] == s2["hotel_name"] == hname
    # both selected → summary groups them as one hotel, two players
    for p in (p1, p2):
        client.post(f"/api/tournaments/{t['id']}/players",
                    json={"player_id": p["id"], "selection_status": "selected"})
    summ = {r["hotel_name"]: r["players"] for r in
            client.get(f"/api/tournaments/{t['id']}/hotel-summary").json()}
    assert summ.get(hname) == 2


def test_hotel_confidential_report():
    """First page: pivot (hotel → players + officials counts). Following pages:
    each player/official as first-initial + last name. Selected only on the
    player side; officials come via assignment.room_block_id."""
    t, h = _tournament(), _hotel()
    # two selected players staying at the hotel
    p1 = _ok(client.post("/api/players", json={
        "usta_number": "RPT" + uuid.uuid4().hex[:6], "first_name": "Alice", "last_name": "Adams", "gender": "female", "birthdate": "2010-01-01"}))
    p2 = _ok(client.post("/api/players", json={
        "usta_number": "RPT" + uuid.uuid4().hex[:6], "first_name": "Bob", "last_name": "Brown", "gender": "male", "birthdate": "2010-01-01"}))
    for p in (p1, p2):
        client.post(f"/api/tournaments/{t['id']}/players",
                    json={"player_id": p["id"], "selection_status": "selected"})
        client.post(f"/api/tournaments/{t['id']}/player-hotels",
                    json={"usta_number": p["usta_number"], "hotel_name": h["name"]})
    # one official with a hotel via a room_block + assignment
    o = _ok(client.post("/api/officials", json={"first_name": "Cara", "last_name": "Clark"}))
    blk = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "kind": "official", "room_count": 5}))
    _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                    json={"official_id": o["id"], "room_block_id": blk["id"]}))
    rep = client.get(f"/api/tournaments/{t['id']}/hotel-confidential-report").json()
    # pivot row for our hotel: 2 players + 1 official = 3
    row = next(r for r in rep["summary"] if r["hotel_name"] == h["name"])
    assert row["players"] == 2 and row["officials"] == 1 and row["total"] == 3
    # initials format
    names = [p["name"] for p in rep["players"]]
    assert "A. Adams" in names and "B. Brown" in names
    assert any(o["name"] == "C. Clark" for o in rep["officials"])
    # totals
    assert rep["totals"]["players"] == 2 and rep["totals"]["officials"] == 1


def test_tshirt_order_lifecycle():
    """T-shirt summary should report requested vs on_hand vs to_order per size,
    then snapshot at order time so later roster changes can be compared."""
    t = _tournament()
    # Three selected players with t-shirt sizes (two YM + one AL).
    for size in ("Youth Medium", "Youth Medium", "Adult Large"):
        p = _player(first_name="A", last_name="P-" + uuid.uuid4().hex[:4])
        _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "player_id": p["id"], "selection_status": "selected", "t_shirt_size": size}))
    rep = client.get(f"/api/tournaments/{t['id']}/tshirt-order").json()
    by = {r["size"]: r for r in rep["rows"]}
    assert by["YM"]["requested"] == 2 and by["YM"]["on_hand"] == 0 and by["YM"]["to_order"] == 2
    assert by["AL"]["requested"] == 1 and by["AL"]["to_order"] == 1
    assert by["YS"]["requested"] == 0 and by["YS"]["to_order"] == 0
    assert rep["ordered_at"] is None
    assert rep["totals"]["requested"] == 3 and rep["totals"]["to_order"] == 3
    # Set inventory: 1 YM on hand → to_order drops to 1
    rep2 = client.put(f"/api/tournaments/{t['id']}/tshirt-inventory",
                      json={"on_hand": {"YM": 1}}).json()
    by2 = {r["size"]: r for r in rep2["rows"]}
    assert by2["YM"]["on_hand"] == 1 and by2["YM"]["to_order"] == 1
    # Place the order: ordered_at = today, snapshot frozen at current request
    rep3 = client.post(f"/api/tournaments/{t['id']}/tshirt-order").json()
    assert rep3["ordered_at"] is not None
    by3 = {r["size"]: r for r in rep3["rows"]}
    assert by3["YM"]["snapshot"] == 2 and by3["AL"]["snapshot"] == 1
    # Add another YM player → live requested goes to 3, snapshot still 2
    p = _player(first_name="Z", last_name="Z-" + uuid.uuid4().hex[:4])
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected", "t_shirt_size": "Youth Medium"}))
    rep4 = client.get(f"/api/tournaments/{t['id']}/tshirt-order").json()
    by4 = {r["size"]: r for r in rep4["rows"]}
    assert by4["YM"]["requested"] == 3 and by4["YM"]["snapshot"] == 2  # drift from order
    # Cancel the order → snapshot + ordered_at cleared, inventory kept
    assert client.delete(f"/api/tournaments/{t['id']}/tshirt-order").status_code == 204
    rep5 = client.get(f"/api/tournaments/{t['id']}/tshirt-order").json()
    assert rep5["ordered_at"] is None
    assert all(r["snapshot"] is None for r in rep5["rows"])
    assert {r["size"]: r["on_hand"] for r in rep5["rows"]}["YM"] == 1  # inventory survives


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

    # Audit N1: late-entry filing now requires the player to exist in Setup
    # first (no more silent gender='female' default). Pre-create them.
    num = "LATE" + uuid.uuid4().hex[:6]
    _player(usta_number=num, first_name="Lee", last_name="Tardy", gender="male")
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


def test_part_b_inline_edits():
    """PUT (in-grid edit) on the Part B lists updates the editable fields."""
    t, p = _tournament(), _player()
    u = p["usta_number"]

    # late entry: edit division + events
    le = _ok(client.post(f"/api/tournaments/{t['id']}/late-entries",
                         json={"usta_number": u, "age_division": "B16", "events": "Singles"}))
    upd = _ok(client.put(f"/api/late-entries/{le['id']}",
                         json={"age_division": "B18", "events": "Doubles", "request_date": None, "request_time": None}), 200)
    assert upd["age_division"] == "B18" and upd["events"] == "Doubles"

    # scheduling avoidance
    sa = _ok(client.post(f"/api/tournaments/{t['id']}/scheduling-avoidances",
                         json={"usta_number": u, "avoid_day": "Mon"}))
    sau = _ok(client.put(f"/api/scheduling-avoidances/{sa['id']}",
                         json={"avoid_day": "Tue", "avoid_time_range": "AM"}), 200)
    assert sau["avoid_day"] == "Tue" and sau["avoid_time_range"] == "AM"

    # division flexibility
    df = _ok(client.post(f"/api/tournaments/{t['id']}/division-flex",
                         json={"usta_number": u, "home_division": "B12"}))
    dfu = _ok(client.put(f"/api/division-flex/{df['id']}",
                         json={"home_division": "B14", "willing_divisions": "B16"}), 200)
    assert dfu["home_division"] == "B14" and dfu["willing_divisions"] == "B16"

    # player hotel: edited name resolves to one canonical Hotels row
    ph = _ok(client.post(f"/api/tournaments/{t['id']}/player-hotels",
                         json={"usta_number": u, "hotel_name": "Marriott", "lodging_plan": "Hotel"}))
    phu = _ok(client.put(f"/api/player-hotels/{ph['id']}",
                         json={"hotel_name": "  hilton   downtown ", "lodging_plan": "Commuter"}), 200)
    assert phu["hotel_name"] == "hilton downtown" and phu["lodging_plan"] == "Commuter" and phu["hotel_id"]


def test_pairing_and_doubles_update():
    t, a, b = _tournament(), _player(), _player()
    # pairing: edit age_division + relationship (members stay add/delete)
    g = _ok(client.post(f"/api/tournaments/{t['id']}/pairing-avoidances", json={
        "age_division": "B14", "relationship": "same_club",
        "members": [{"usta_number": a["usta_number"]}, {"usta_number": b["usta_number"]}]}))
    gu = _ok(client.put(f"/api/pairing-avoidances/{g['id']}",
                        json={"age_division": "B16", "relationship": "siblings"}), 200)
    assert gu["age_division"] == "B16" and gu["relationship"] == "siblings"
    # doubles request: edit age_division on a pending mutual request
    r = _ok(client.post(f"/api/tournaments/{t['id']}/doubles-requests", json={
        "usta_number": a["usta_number"], "age_division": "G14", "partner_usta": b["usta_number"]}))
    rid = r["request"]["id"]
    ru = client.put(f"/api/doubles-requests/{rid}", json={"age_division": "G16"})
    assert ru.status_code == 200 and ru.json()["age_division"] == "G16"


def test_withdrawal_update_keeps_reason_rule():
    t, p = _tournament(), _player()
    client.post(f"/api/tournaments/{t['id']}/players", json={"player_id": p["id"], "selection_status": "selected"})
    w = _ok(client.post(f"/api/tournaments/{t['id']}/withdrawals",
                        json={"usta_number": p["usta_number"], "reason": "injury"}))
    # a selected player still needs a reason on edit
    assert client.put(f"/api/withdrawals/{w['id']}", json={"reason": "", "notes": "x"}).status_code == 400
    upd = _ok(client.put(f"/api/withdrawals/{w['id']}",
                        json={"reason": "illness", "notes": "doctor note", "events": "Singles"}), 200)
    assert upd["reason"] == "illness" and upd["notes"] == "doctor note"


def test_doubles_mutual_verification():
    t = _tournament()
    a, b = _player(), _player()
    # Audit F15: doubles pair members must be on the tournament roster.
    for p in (a, b):
        client.post(f"/api/tournaments/{t['id']}/players",
                    json={"player_id": p["id"], "selection_status": "selected"})
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
    for p in (a, b):
        client.post(f"/api/tournaments/{t['id']}/players",
                    json={"player_id": p["id"], "selection_status": "selected"})
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
    """Audit F1 + F25: hotel-analytics counts *stays* (one per (player,
    tournament)) — a player attending two tournaments at the same hotel must
    show 2, not 1. Per-tournament summary counts distinct players (1)."""
    t1, t2, p = _tournament(), _tournament(), _player()
    for t in (t1, t2):
        client.post(f"/api/tournaments/{t['id']}/players",
                    json={"player_id": p["id"], "selection_status": "selected"})
    hname = "Marriott " + uuid.uuid4().hex[:4]
    s1 = _ok(client.post(f"/api/tournaments/{t1['id']}/player-hotels",
                         json={"usta_number": p["usta_number"], "hotel_name": hname}))
    s2 = _ok(client.post(f"/api/tournaments/{t2['id']}/player-hotels",
                         json={"usta_number": p["usta_number"], "hotel_name": hname}))
    assert s1["hotel_name"] == hname and s2["hotel_name"] == hname
    # CVB analytics: same player at the same hotel in 2 tournaments = 2 stays.
    totals = {r["hotel_name"]: r["stays"] for r in client.get("/api/hotel-analytics").json()}
    assert totals.get(hname, 0) >= 2, totals
    # Per-tournament summary still counts distinct players (1).
    summ = {r["hotel_name"]: r["players"] for r in
            client.get(f"/api/tournaments/{t1['id']}/hotel-summary").json()}
    assert summ.get(hname) == 1
    assert client.delete(f"/api/player-hotels/{s1['id']}").status_code == 204
    assert client.delete(f"/api/player-hotels/{s2['id']}").status_code == 204


def test_summaries_exclude_withdrawn_and_alternates():
    t = _tournament()
    sel, alt, wd = _player(), _player(), _player()
    for pl, st in [(sel, "selected"), (alt, "alternate"), (wd, "withdrawn")]:
        client.post(f"/api/tournaments/{t['id']}/players",
                    json={"player_id": pl["id"], "selection_status": st, "t_shirt_size": "Adult Medium"})
    hotel = "Hyatt " + uuid.uuid4().hex[:4]
    for pl in (sel, alt, wd):
        client.post(f"/api/tournaments/{t['id']}/player-hotels",
                    json={"usta_number": pl["usta_number"], "hotel_name": hotel})
    # hotel summary counts only the selected player
    summ = {r["hotel_name"]: r["players"] for r in
            client.get(f"/api/tournaments/{t['id']}/hotel-summary").json()}
    assert summ.get(hotel) == 1
    # t-shirt list excludes alternates/withdrawals
    mine = {r["usta_number"] for r in client.get("/api/tshirts").json() if r["tournament_id"] == t["id"]}
    assert sel["usta_number"] in mine
    assert alt["usta_number"] not in mine and wd["usta_number"] not in mine

    # t-shirt cumulative list picks up a roster entry's size (normalized to canonical)
    p2 = _player()
    client.post(f"/api/tournaments/{t['id']}/players",
                json={"player_id": p2["id"], "age_division": "G12", "t_shirt_size": "YM"})
    shirts = client.get("/api/tshirts").json()
    assert any(r["usta_number"] == p2["usta_number"] and r["t_shirt_size"] == "Youth Medium" for r in shirts)


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
    r = client.put(f"/api/players/{p['id']}", json={"usta_number": p["usta_number"], "first_name": "A", "last_name": "After", "gender": "female", "birthdate": "2010-01-01"})
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
    client.put(f"/api/players/{p['id']}", json={"usta_number": p["usta_number"], "first_name": "A", "last_name": "Married", "gender": "female", "birthdate": "2010-01-01"})

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


def test_work_date_out_of_window_flag():
    # tournament play window is 2026-06-01..2026-06-04 (see _tournament default)
    t, o = _tournament(), _official()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    a = _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": "2026-07-01", "working_as": "roving_official"}))
    assert a["work_date_out_of_window"] is True, a
    rep = client.get(f"/api/tournaments/{t['id']}/reports/officials").json()
    assert rep["totals"]["out_of_window_count"] >= 1


def test_room_block_create_returns_rooms_remaining():
    t, h = _tournament(), _hotel()
    rb = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "room_count": 4}))
    assert rb["rooms_remaining"] == 4  # nobody assigned yet


def test_late_entry_past_deadline_flag():
    t = _tournament(late_entry_deadline="2026-05-01")
    p1, p2 = _player(), _player()
    late = _ok(client.post(f"/api/tournaments/{t['id']}/late-entries",
                           json={"usta_number": p1["usta_number"], "request_date": "2026-05-10"}))
    assert late["past_deadline"] is True
    ontime = _ok(client.post(f"/api/tournaments/{t['id']}/late-entries",
                             json={"usta_number": p2["usta_number"], "request_date": "2026-04-20"}))
    assert ontime["past_deadline"] is False


def test_doubles_random_requires_division():
    t, p = _tournament(), _player()
    bad = client.post(f"/api/tournaments/{t['id']}/doubles-requests",
                      json={"usta_number": p["usta_number"], "wants_random": True})
    assert bad.status_code == 400, bad.text


def test_account_reset_invalidates_sessions():
    o = _official(first_name="Reset", last_name="Me")
    uname = "rst" + uuid.uuid4().hex[:6]
    assert client.put(f"/api/officials/{o['id']}/account",
                      json={"username": uname, "password": "pw1"}).status_code == 200
    off = TestClient(app)
    assert off.post("/api/auth/login", json={"username": uname, "password": "pw1"}).status_code == 200
    assert off.get("/api/me").status_code == 200
    # admin resets the login -> the official's existing session is invalidated
    assert client.put(f"/api/officials/{o['id']}/account",
                      json={"username": uname, "password": "pw2"}).status_code == 200
    assert off.get("/api/me").status_code == 401
