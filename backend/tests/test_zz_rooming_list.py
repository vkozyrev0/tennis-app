"""Per-hotel rooming list (GET .../rooming-list).

Each official-comp room block with its occupants (name, nights = worked-day span,
dietary). Declined assignments are excluded. Named to sort last."""
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
def _ensure_admin_session():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _hotel():
    return _ok(client.post("/api/hotels", json={"name": "H " + uuid.uuid4().hex[:5]}))


def _block(tid, hid, rooms=4):
    return _ok(client.post("/api/room-blocks", json={
        "hotel_id": hid, "tournament_id": tid, "kind": "official",
        "room_count": rooms, "check_in": "2026-06-01", "check_out": "2026-06-04"}))


def _official(diet=None):
    body = {"first_name": "Room", "last_name": "Ee " + uuid.uuid4().hex[:5]}
    if diet:
        body["dietary_restrictions"] = diet
    o = _ok(client.post("/api/officials", json=body))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign(tid, oid, block_id, days=()):
    a = _ok(client.post(f"/api/tournaments/{tid}/assignments",
                        json={"official_id": oid, "room_block_id": block_id}))
    for d in days:
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": d, "working_as": "roving_official"}))
    return a


def _rooming(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/rooming-list"), 200)


def test_block_lists_occupants_with_nights_and_dietary():
    t = _tournament()
    h = _hotel()
    b = _block(t["id"], h["id"])
    o = _official(diet="vegetarian")
    _assign(t["id"], o["id"], b["id"], days=["2026-06-01", "2026-06-03"])
    rl = _rooming(t["id"])
    assert rl["totals"]["blocks"] == 1
    assert rl["totals"]["occupants"] == 1
    occ = rl["blocks"][0]["occupants"][0]
    assert occ["dietary_restrictions"] == "vegetarian"
    assert occ["first_night"] == "2026-06-01"
    assert occ["last_night"] == "2026-06-03"


def test_empty_block_has_no_occupants():
    t = _tournament()
    h = _hotel()
    _block(t["id"], h["id"])
    rl = _rooming(t["id"])
    assert rl["totals"]["blocks"] == 1
    assert rl["blocks"][0]["occupants"] == []


def test_occupants_grouped_by_block():
    t = _tournament()
    h = _hotel()
    b1, b2 = _block(t["id"], h["id"]), _block(t["id"], h["id"])
    o1, o2 = _official(), _official()
    _assign(t["id"], o1["id"], b1["id"], days=["2026-06-01"])
    _assign(t["id"], o2["id"], b2["id"], days=["2026-06-02"])
    rl = _rooming(t["id"])
    by_block = {b["block_id"]: [o["official_name"] for o in b["occupants"]] for b in rl["blocks"]}
    assert len(by_block[b1["id"]]) == 1
    assert len(by_block[b2["id"]]) == 1
    assert by_block[b1["id"]] != by_block[b2["id"]]
    assert rl["totals"]["occupants"] == 2


def test_rooming_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/rooming-list").status_code == 404
