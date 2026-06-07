"""Day-by-day schedule (GET .../schedule).

For each play-window day: who works (official, role, site). One entry per
(official, day); declined assignments excluded. Named to sort last."""
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


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Sch", "last_name": "Ed " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign_day(tid, oid, day):
    a = _ok(client.post(f"/api/tournaments/{tid}/assignments", json={"official_id": oid}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": day, "working_as": "roving_official"}))
    return a


def _schedule(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/schedule"), 200)


def test_days_span_window_with_entries():
    t = _tournament()
    o = _official()
    _assign_day(t["id"], o["id"], "2026-06-02")
    sch = _schedule(t["id"])
    assert [d["date"] for d in sch["days"]] == ["2026-06-01", "2026-06-02", "2026-06-03"]
    by_date = {d["date"]: d for d in sch["days"]}
    assert by_date["2026-06-01"]["count"] == 0
    assert by_date["2026-06-02"]["count"] == 1
    e = by_date["2026-06-02"]["entries"][0]
    assert e["working_as"] == "roving_official"
    assert e["official_name"].startswith("Ed")


def test_two_officials_same_day():
    t = _tournament()
    o1, o2 = _official(), _official()
    _assign_day(t["id"], o1["id"], "2026-06-01")
    _assign_day(t["id"], o2["id"], "2026-06-01")
    sch = _schedule(t["id"])
    day1 = next(d for d in sch["days"] if d["date"] == "2026-06-01")
    assert day1["count"] == 2


def test_schedule_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/schedule").status_code == 404
