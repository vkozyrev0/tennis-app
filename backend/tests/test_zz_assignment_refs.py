"""Assignment site + room-block must belong to the tournament (audit D5/D6).

UI already filters both pickers; the API used to accept any site/room_block
FK. These tests pin the hard 400s so a scripted client can't mis-route mileage
or hotel inventory across events.
"""
import uuid

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


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _site():
    return _ok(client.post("/api/sites", json={"name": "S " + uuid.uuid4().hex[:6]}))


def _official():
    return _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "R " + uuid.uuid4().hex[:5]}))


def _hotel():
    return _ok(client.post("/api/hotels", json={"name": "H " + uuid.uuid4().hex[:6]}))


def _link(tid, *site_ids):
    _ok(client.put(f"/api/tournaments/{tid}/sites",
                   json={"site_ids": list(site_ids)}), 200)


def test_create_rejects_unlinked_site():
    t, s, o = _tournament(), _site(), _official()
    r = client.post(f"/api/tournaments/{t['id']}/assignments",
                    json={"official_id": o["id"], "site_id": s["id"]})
    assert r.status_code == 400, r.text
    assert "not linked" in r.json()["detail"].lower()


def test_create_accepts_linked_site():
    t, s, o = _tournament(), _site(), _official()
    _link(t["id"], s["id"])
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"], "site_id": s["id"]}))
    assert a["site_id"] == s["id"]


def test_create_rejects_foreign_room_block():
    t1, t2 = _tournament(), _tournament()
    h, o = _hotel(), _official()
    blk = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t2["id"], "kind": "official",
        "room_count": 3}))
    r = client.post(f"/api/tournaments/{t1['id']}/assignments",
                    json={"official_id": o["id"], "room_block_id": blk["id"]})
    assert r.status_code == 400, r.text
    assert "does not belong" in r.json()["detail"].lower()


def test_create_accepts_own_room_block():
    t, h, o = _tournament(), _hotel(), _official()
    blk = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "kind": "official",
        "room_count": 3}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"], "room_block_id": blk["id"]}))
    assert a["room_block_id"] == blk["id"]


def test_update_rejects_unlinked_site():
    t, s_ok, s_bad, o = _tournament(), _site(), _site(), _official()
    _link(t["id"], s_ok["id"])
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"], "site_id": s_ok["id"]}))
    r = client.put(f"/api/assignments/{a['id']}",
                   json={"official_id": o["id"], "site_id": s_bad["id"]})
    assert r.status_code == 400, r.text
    assert "not linked" in r.json()["detail"].lower()


def test_bulk_rejects_unlinked_site():
    t, s, o = _tournament(), _site(), _official()
    r = client.post(f"/api/tournaments/{t['id']}/assignments/bulk",
                    json={"official_ids": [o["id"]], "site_id": s["id"]})
    assert r.status_code == 400, r.text
    assert "not linked" in r.json()["detail"].lower()


def test_null_site_and_hotel_still_ok():
    t, o = _tournament(), _official()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"]}))
    assert a["site_id"] is None and a.get("room_block_id") is None
