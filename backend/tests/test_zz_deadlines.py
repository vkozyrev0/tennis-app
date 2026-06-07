"""Cross-tournament approaching-deadline banner.

`GET /api/dashboard/deadlines` lists registration / late-entry / play-start dates
that are coming up (or just passed) across not-yet-finished tournaments. Dates
are set RELATIVE to today so the test is clock-independent.

Named to sort last (same rationale as the other test_zz modules)."""
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


def _iso(days):
    return (date.today() + timedelta(days=days)).isoformat()


def _tournament(name, play_start_days, play_end_days, reg=None, late=None):
    body = {"name": name, "type": "junior",
            "play_start_date": _iso(play_start_days), "play_end_date": _iso(play_end_days)}
    if reg is not None:
        body["registration_deadline"] = _iso(reg)
    if late is not None:
        body["late_entry_deadline"] = _iso(late)
    return _ok(client.post("/api/tournaments", json=body))


def _deadlines(within=14):
    return client.get(f"/api/dashboard/deadlines?within_days={within}").json()["deadlines"]


def test_upcoming_deadline_appears():
    tag = uuid.uuid4().hex[:6]
    t = _tournament("Soon " + tag, play_start_days=20, play_end_days=24, late=5)
    items = [d for d in _deadlines() if d["tournament_id"] == t["id"]]
    late = next(d for d in items if d["kind"] == "late_entry")
    assert late["days_until"] == 5
    # play_start is 20d out → outside the 14d window, so NOT listed
    assert not any(d["kind"] == "play_start" for d in items)


def test_finished_tournament_is_excluded():
    tag = uuid.uuid4().hex[:6]
    t = _tournament("Past " + tag, play_start_days=-10, play_end_days=-5, late=-7)
    assert not any(d["tournament_id"] == t["id"] for d in _deadlines())


def test_just_passed_deadline_still_shows_briefly():
    tag = uuid.uuid4().hex[:6]
    # tournament still upcoming, but its registration deadline lapsed 2 days ago
    t = _tournament("JustPast " + tag, play_start_days=10, play_end_days=14, reg=-2)
    reg = next(d for d in _deadlines() if d["tournament_id"] == t["id"] and d["kind"] == "registration")
    assert reg["days_until"] == -2


def test_within_days_window_widens():
    tag = uuid.uuid4().hex[:6]
    t = _tournament("Far " + tag, play_start_days=40, play_end_days=44, late=30)
    assert not any(d["tournament_id"] == t["id"] for d in _deadlines(within=14))
    assert any(d["tournament_id"] == t["id"] and d["kind"] == "late_entry"
               for d in _deadlines(within=45))
