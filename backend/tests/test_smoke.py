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
    r = _ok(client.post("/api/rates", json={"cert_type": "chair", "rate_per_day": 175.5, "effective_from": eff}))
    assert client.put(f"/api/rates/{r['id']}",
                      json={"cert_type": "chair", "rate_per_day": 180, "effective_from": eff}).status_code == 200
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
    a = _ok(client.post(f"/api/assignments/{a['id']}/days", json={"work_date": today, "working_as": "roving"}))
    a = _ok(client.post(f"/api/assignments/{a['id']}/days", json={"work_date": tomorrow, "working_as": "chair"}))
    # seeded rates: roving 150, chair 200 -> pay 350
    assert a["pay"] == 350.0, a
    assert a["mileage"] == 97.5, a
    assert a["missing_distance"] is False
    assert a["total"] == 447.5
    # duplicate official on tournament rejected
    assert client.post(f"/api/tournaments/{t['id']}/assignments",
                       json={"official_id": o["id"]}).status_code == 409
    assert client.delete(f"/api/assignments/{a['id']}").status_code == 204


def test_assignment_missing_distance_and_hotel_mismatch():
    t, o, s, h = _tournament(), _official(), _site(), _hotel()
    # no distance on file -> mileage None, missing_distance True
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"], "site_id": s["id"]}))
    a = _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": date.today().isoformat(), "working_as": "referee"}))
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
