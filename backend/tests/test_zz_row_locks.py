"""D27: capacity and payment checks read then write, so the read must lock.

Without the lock two admins can both pass the check and then both write. This
drives the room-block guard directly and proves the block row is held for the
transaction; the payroll batch uses the same `FOR UPDATE` pattern.
"""
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.assignment_ops import _check_room_capacity
from app.db import get_conn
from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


def test_room_capacity_check_locks_the_block_row():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    t = client.post("/api/tournaments", json={
        "name": "Lock " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04",
    }).json()
    h = client.post("/api/hotels", json={"name": "H " + uuid.uuid4().hex[:6]}).json()
    b = client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"],
        "kind": "official", "room_count": 1,
    }).json()

    holder = get_conn()
    other = get_conn()
    try:
        with holder.cursor() as cur:
            _check_room_capacity(cur, b["id"])
        with other.cursor() as cur:
            with pytest.raises(psycopg.errors.LockNotAvailable):
                cur.execute("SELECT 1 FROM room_block WHERE id = %s FOR UPDATE NOWAIT",
                            (b["id"],))
        other.rollback()
        holder.rollback()
        # The block is lockable again once the holder's transaction ends, which
        # proves the first failure was this lock and not a broken query.
        with other.cursor() as cur:
            cur.execute("SELECT 1 FROM room_block WHERE id = %s FOR UPDATE NOWAIT",
                        (b["id"],))
    finally:
        other.rollback()
        other.close()
        holder.close()
