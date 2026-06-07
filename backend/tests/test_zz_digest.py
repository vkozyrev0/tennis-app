"""Cross-tournament digest (GET /api/dashboard/digest).

One row per not-yet-finished tournament with its soonest key date + a tally of
open tasks (unfiled inbox, pending/declined officials, uncovered play-window
days, incomplete roster entries), plus grand totals.

Clock-independent: dates are relative to today. Named to sort last."""
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
def _ensure_admin_session():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _iso(d):
    return d.isoformat()


def _future_tournament(reg_in_days=None):
    start = date.today() + timedelta(days=20)
    body = {"name": "Dig " + uuid.uuid4().hex[:8], "type": "junior",
            "play_start_date": _iso(start), "play_end_date": _iso(start + timedelta(days=2))}
    if reg_in_days is not None:
        body["registration_deadline"] = _iso(date.today() + timedelta(days=reg_in_days))
    return _ok(client.post("/api/tournaments", json=body))


def _digest():
    return _ok(client.get("/api/dashboard/digest"), 200)


def _row(dg, tid):
    return next((r for r in dg["tournaments"] if r["tournament_id"] == tid), None)


def test_active_tournament_appears_with_uncovered_days():
    t = _future_tournament()
    dg = _digest()
    row = _row(dg, t["id"])
    assert row is not None
    # 3-day window, nobody assigned → 3 uncovered days
    assert row["tasks"]["uncovered_days"] == 3
    assert row["open_tasks"] >= 3


def test_finished_tournament_excluded():
    start = date.today() - timedelta(days=30)
    t = _ok(client.post("/api/tournaments", json={
        "name": "Past " + uuid.uuid4().hex[:8], "type": "junior",
        "play_start_date": _iso(start), "play_end_date": _iso(start + timedelta(days=2))}))
    dg = _digest()
    assert _row(dg, t["id"]) is None


def test_unfiled_inbox_counted():
    t = _future_tournament()
    _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "from_address": "a@example.com",
        "subject": "hi", "body": "withdrawing"}))
    row = _row(_digest(), t["id"])
    assert row["tasks"]["unfiled_inbox"] == 1


def test_incomplete_roster_counted_and_totals():
    t = _future_tournament()
    p = _ok(client.post("/api/players", json={
        "usta_number": str(uuid.uuid4().int % 10**10).zfill(10),
        "first_name": "Dg", "last_name": "P" + uuid.uuid4().hex[:5], "gender": "female"}))
    # selected but no division / shirt → incomplete
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "usta_number": p["usta_number"], "first_name": p["first_name"],
        "last_name": p["last_name"], "gender": "female", "selection_status": "selected"}))
    dg = _digest()
    row = _row(dg, t["id"])
    assert row["tasks"]["roster_incomplete"] == 1
    # totals aggregate across tournaments and never go below this row's count
    assert dg["totals"]["roster_incomplete"] >= 1
    assert dg["totals"]["active_tournaments"] >= 1


def test_conflicts_in_digest_tasks_and_totals():
    t = _future_tournament()
    # official with no certs, assigned a day → uncertified hard conflict
    o = _ok(client.post("/api/officials", json={
        "first_name": "Dg", "last_name": "O" + uuid.uuid4().hex[:5]}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    day = _iso(date.today() + timedelta(days=20))  # within the play window
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": day, "working_as": "chair_umpire"}))
    dg = _digest()
    row = _row(dg, t["id"])
    assert row["tasks"]["conflicts"] == 1
    assert dg["totals"]["conflicts"] >= 1


def test_next_deadline_surfaced():
    t = _future_tournament(reg_in_days=5)
    row = _row(_digest(), t["id"])
    assert row["next_deadline"] is not None
    # the registration deadline (5 days out) is sooner than play_start (20 days)
    assert row["next_deadline"]["kind"] == "registration"
    assert row["next_deadline"]["days_until"] == 5
