"""Pre-tournament readiness scorecard (GET .../readiness).

Rolls the dashboard signals into pass/warn/fail per area; `ready` is true when
no fails. Named to sort last."""
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


def _tournament(start="2026-06-01", end="2026-06-02"):
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start, "play_end_date": end}))


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Rdy", "last_name": "Off " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _readiness(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/readiness"), 200)


def _check(r, key):
    return next(c for c in r["checks"] if c["key"] == key)


def test_empty_tournament_has_coverage_fail():
    t = _tournament()
    r = _readiness(t["id"])
    # nobody assigned → every play day uncovered → coverage fails → not ready
    assert _check(r, "coverage")["status"] == "fail"
    assert r["ready"] is False
    assert r["summary"]["fail"] >= 1


def test_fully_covered_two_day_event_is_ready():
    t = _tournament(start="2026-06-01", end="2026-06-02")
    o = _official()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    for d in ("2026-06-01", "2026-06-02"):
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": d, "working_as": "roving_official"}))
    r = _readiness(t["id"])
    assert _check(r, "coverage")["status"] == "pass"
    assert _check(r, "conflicts")["status"] == "pass"
    # the one official hasn't responded → responses is a warn (not a fail)
    assert _check(r, "responses")["status"] == "warn"
    # warns don't block readiness
    assert r["ready"] is True
    assert r["summary"]["fail"] == 0


def test_readiness_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/readiness").status_code == 404
