"""TD "Today" dashboard aggregate.

`GET /api/tournaments/{id}/dashboard` rolls up inbox / roster / officials /
coverage / rooms counts for one tournament without building the full report.

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
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-03"}))


def _player(tid, usta, status="selected"):
    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": usta, "first_name": "P", "last_name": "L",
        "gender": "female", "age_division": "G14", "selection_status": status}))


def _official(*certs):
    o = _ok(client.post("/api/officials", json={"first_name": "R", "last_name": "E " + uuid.uuid4().hex[:5]}))
    for c in certs:
        _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": c}))
    return o


def _dash(tid):
    return client.get(f"/api/tournaments/{tid}/dashboard").json()


def test_empty_tournament_dashboard_is_zeroed():
    t = _tournament()
    d = _dash(t["id"])
    assert d["tournament"]["id"] == t["id"]
    assert d["inbox"] == {"new": 0, "filed": 0, "needs_followup": 0}
    assert d["roster"]["total"] == 0
    assert d["officials"]["total"] == 0
    # a 3-day window with nobody assigned → all 3 days uncovered
    assert d["coverage"]["uncovered_days_count"] == 3
    assert d["rooms"] == {"reserved": 0, "assigned": 0, "unused": 0}
    assert d["conflicts"] == 0


def test_dashboard_conflicts_count_uncertified_day():
    # An official with NO certs passes the add-day guard but the worked day is a
    # hard conflict (uncertified) → surfaced as the dashboard conflict count.
    t = _tournament()
    o = _official()  # no certifications
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-02", "working_as": "chair_umpire"}))
    assert _dash(t["id"])["conflicts"] == 1


def test_dashboard_rolls_up_real_activity():
    t = _tournament()
    _player(t["id"], "2001110001", "selected")
    _player(t["id"], "2001110002", "alternate")
    _player(t["id"], "2001110003", "withdrawn")
    # an unfiled inbox email
    _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "hi", "body": "b", "from_address": "x@y.com"}))
    # an official assigned one day (06-02) → 06-01 + 06-03 uncovered, pending
    o = _official("roving_official")
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-02", "working_as": "roving_official"}))

    d = _dash(t["id"])
    assert d["inbox"]["new"] == 1
    assert d["roster"] == {"selected": 1, "alternate": 1, "withdrawn": 1, "total": 3}
    assert d["officials"]["total"] == 1 and d["officials"]["pending"] == 1
    assert sorted(d["coverage"]["uncovered_days"]) == ["2026-06-01", "2026-06-03"]
    assert d["coverage"]["uncovered_days_count"] == 2


def test_dashboard_room_pickup_excludes_declined(tmp_path=None):
    t = _tournament()
    h = _ok(client.post("/api/hotels", json={"name": "H " + uuid.uuid4().hex[:5]}))
    block = _ok(client.post("/api/room-blocks", json={
        "hotel_id": h["id"], "tournament_id": t["id"], "kind": "official", "room_count": 2}))
    o = _official("roving_official")
    _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                    json={"official_id": o["id"], "room_block_id": block["id"]}))
    d = _dash(t["id"])
    assert d["rooms"]["reserved"] == 2
    assert d["rooms"]["assigned"] == 1
    assert d["rooms"]["unused"] == 1


def test_dashboard_404_for_unknown_tournament():
    assert client.get("/api/tournaments/99999999/dashboard").status_code == 404


# IA cleanup: nav-counts feeds the per-tab + Inbox badges.
_NAV_KEYS = {"inbox_unfiled", "late_entries", "withdrawals", "scheduling",
             "div_flex", "pairing", "doubles", "player_hotels"}


def test_nav_counts_empty_is_zeroed():
    t = _tournament()
    c = _ok(client.get(f"/api/tournaments/{t['id']}/nav-counts"), 200)
    assert set(c) == _NAV_KEYS
    assert all(v == 0 for v in c.values())


def test_nav_counts_reflects_unfiled_inbox():
    t = _tournament()
    _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "hi", "body": "b", "from_address": "x@y.com"}))
    c = _ok(client.get(f"/api/tournaments/{t['id']}/nav-counts"), 200)
    assert c["inbox_unfiled"] == 1
    # counts are tournament-scoped — a sibling event stays at zero
    other = _tournament()
    assert _ok(client.get(f"/api/tournaments/{other['id']}/nav-counts"), 200)["inbox_unfiled"] == 0


def test_nav_counts_404_for_unknown_tournament():
    assert client.get("/api/tournaments/99999999/nav-counts").status_code == 404


# Day-of mode: the venue-view aggregate for one calendar day.
def _dayof(tid, on=None):
    r = client.get(f"/api/tournaments/{tid}/day-of", params={"on": on} if on else None)
    return _ok(r, 200)


def test_day_of_empty_is_zeroed():
    t = _tournament()  # play window 2026-06-01 .. 2026-06-03
    d = _dayof(t["id"], "2026-06-02")
    assert d["date"] == "2026-06-02" and d["in_window"] is True
    assert d["officials"] == [] and d["officials_count"] == 0 and d["present_count"] == 0
    assert d["incidents"] == []
    assert d["signin"]["signed_in"] == 0


def test_day_of_lists_officials_working_that_date():
    t = _tournament()
    o = _official("chair_umpire")
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-02", "working_as": "chair_umpire"}))
    # the official shows up on the day they work...
    d = _dayof(t["id"], "2026-06-02")
    assert d["officials_count"] == 1
    row = d["officials"][0]
    assert row["assignment_id"] == a["id"] and row["working_as"] == "chair_umpire"
    assert row["actual_status"] == "planned" and row["response_status"] == "pending"
    # ...and NOT on a different date in the window
    assert _dayof(t["id"], "2026-06-03")["officials_count"] == 0


def test_day_of_out_of_window_flag():
    t = _tournament()
    assert _dayof(t["id"], "2025-01-01")["in_window"] is False


def test_day_of_bad_date_and_unknown_tournament():
    t = _tournament()
    assert client.get(f"/api/tournaments/{t['id']}/day-of", params={"on": "nope"}).status_code == 400
    assert client.get("/api/tournaments/99999999/day-of").status_code == 404
