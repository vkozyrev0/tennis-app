"""Room-block pickup in the officials report (audit §lodging).

Per official comp block, the report shows rooms reserved (room_count) vs assigned
(assignments pointing at the block) so the TD can release unused rooms before the
hotel cutoff. Totals roll the three up tournament-wide.

Named to sort last (same rationale as the other test_zz modules)."""
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
    return _ok(client.post("/api/hotels", json={"name": "H " + uuid.uuid4().hex[:6]}))


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _report(tid):
    return client.get(f"/api/tournaments/{tid}/reports/officials").json()


def test_pickup_counts_reserved_assigned_remaining():
    t, h = _tournament(), _hotel()
    block = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "kind": "official",
        "room_count": 3, "check_in": "2026-05-31", "check_out": "2026-06-05",
        "confirmation_number": "CONF9"}))
    # assign 2 of the 3 rooms
    for _ in range(2):
        o = _official()
        _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"], "room_block_id": block["id"]}))

    rep = _report(t["id"])
    blocks = rep["room_blocks"]
    assert len(blocks) == 1
    b = blocks[0]
    assert b["hotel_name"] == h["name"]
    assert b["confirmation_number"] == "CONF9"
    assert b["room_count"] == 3
    assert b["assigned"] == 2
    assert b["remaining"] == 1          # one unused → release before cutoff

    tot = rep["totals"]
    assert tot["rooms_reserved"] == 3
    assert tot["rooms_assigned"] == 2
    assert tot["rooms_remaining"] == 1


def test_pickup_excludes_player_blocks_and_other_tournaments():
    t, h = _tournament(), _hotel()
    # a PLAYER-rate block in the same tournament must not appear
    _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "kind": "player", "room_count": 5}))
    # an official block in a DIFFERENT tournament must not appear
    t2 = _tournament()
    _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t2["id"], "kind": "official", "room_count": 4}))

    rep = _report(t["id"])
    assert rep["room_blocks"] == []
    assert rep["totals"]["rooms_reserved"] == 0
    assert rep["totals"]["rooms_assigned"] == 0
    assert rep["totals"]["rooms_remaining"] == 0


def test_fully_picked_up_block_has_zero_remaining():
    t, h = _tournament(), _hotel()
    block = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "kind": "official", "room_count": 1}))
    o = _official()
    _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                    json={"official_id": o["id"], "room_block_id": block["id"]}))
    rep = _report(t["id"])
    assert rep["room_blocks"][0]["remaining"] == 0
    assert rep["totals"]["rooms_remaining"] == 0
