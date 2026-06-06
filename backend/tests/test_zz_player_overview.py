"""Player 360 overview — everything about one player in one place.

`GET /api/players/{id}/overview?tournament_id=` returns the player core, every
tournament they're entered in, and their Part B requests (scoped to the
tournament when given).

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


def _roster(tid, usta):
    return _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": usta, "first_name": "Ovr", "last_name": "View",
        "gender": "female", "age_division": "G14", "selection_status": "selected"}))


def _player_id(usta):
    return next(p for p in client.get("/api/players").json() if p["usta_number"] == usta)["id"]


def test_overview_core_and_entries():
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _roster(t["id"], usta)
    pid = _player_id(usta)
    ov = client.get(f"/api/players/{pid}/overview?tournament_id={t['id']}").json()
    assert ov["player"]["usta_number"] == usta
    assert ov["player"]["last_name"] == "View"
    ent = next(e for e in ov["entries"] if e["tournament_id"] == t["id"])
    assert ent["selection_status"] == "selected" and ent["age_division"] == "G14"
    assert ent["tournament_name"] == client.get(f"/api/tournaments/{t['id']}").json()["name"]


def test_overview_collects_part_b_requests_for_the_tournament():
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _roster(t["id"], usta)
    pid = _player_id(usta)
    # a withdrawal + a scheduling avoidance for this player in this tournament
    _ok(client.post(f"/api/tournaments/{t['id']}/withdrawals", json={"usta_number": usta, "reason": "illness"}))
    _ok(client.post(f"/api/tournaments/{t['id']}/scheduling-avoidances", json={"usta_number": usta, "avoid_day": "Sunday"}))
    ov = client.get(f"/api/players/{pid}/overview?tournament_id={t['id']}").json()
    assert len(ov["requests"]["withdrawals"]) == 1
    assert ov["requests"]["withdrawals"][0]["reason"] == "illness"
    assert len(ov["requests"]["scheduling"]) == 1
    assert ov["requests"]["scheduling"][0]["avoid_day"] == "Sunday"
    assert ov["requests"]["late_entries"] == []


def test_overview_scopes_requests_to_the_given_tournament():
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    t1, t2 = _tournament(), _tournament()
    _roster(t1["id"], usta)
    _roster(t2["id"], usta)
    pid = _player_id(usta)
    _ok(client.post(f"/api/tournaments/{t1['id']}/withdrawals", json={"usta_number": usta, "reason": "x"}))
    # scoped to t2 → no withdrawals; entries still show BOTH tournaments
    ov = client.get(f"/api/players/{pid}/overview?tournament_id={t2['id']}").json()
    assert ov["requests"]["withdrawals"] == []
    assert {e["tournament_id"] for e in ov["entries"]} >= {t1["id"], t2["id"]}


def test_overview_404_unknown_player():
    assert client.get("/api/players/99999999/overview").status_code == 404
