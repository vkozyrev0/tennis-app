"""Availability heatmap matrix (GET .../availability/grid).

Returns the play-window days, one row per official who declared availability or
is assigned (with their available + assigned dates), and per-day totals — the
data behind the staffing heatmap.

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


def _official(*certs):
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    for c in certs:
        _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": c}))
    return o


def _set_avail(tid, oid, dates, hotel=False):
    r = client.put(f"/api/tournaments/{tid}/availability",
                   json={"official_id": oid, "dates": dates, "hotel_needed": hotel})
    assert r.status_code == 200, r.text


def _grid(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/availability/grid"), 200)


def test_days_span_play_window():
    t = _tournament()
    g = _grid(t["id"])
    assert g["days"] == ["2026-06-01", "2026-06-02", "2026-06-03"]
    assert g["officials"] == []


def test_official_row_available_and_hotel():
    t = _tournament()
    o = _official()
    _set_avail(t["id"], o["id"], ["2026-06-01", "2026-06-03"], hotel=True)
    g = _grid(t["id"])
    row = next(r for r in g["officials"] if r["official_id"] == o["id"])
    assert row["available"] == ["2026-06-01", "2026-06-03"]
    assert row["hotel_needed"] is True
    assert row["assigned"] == []


def test_assigned_dates_and_per_day_counts():
    t = _tournament()
    o = _official("roving_official")
    _set_avail(t["id"], o["id"], ["2026-06-01", "2026-06-02"])
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-02", "working_as": "roving_official"}))
    g = _grid(t["id"])
    row = next(r for r in g["officials"] if r["official_id"] == o["id"])
    assert row["assigned"] == ["2026-06-02"]
    per = {d["date"]: d for d in g["per_day"]}
    assert per["2026-06-01"]["available_count"] == 1
    assert per["2026-06-01"]["assigned_count"] == 0
    assert per["2026-06-02"]["available_count"] == 1
    assert per["2026-06-02"]["assigned_count"] == 1


def test_assigned_only_official_appears():
    # An official assigned but who never declared availability still shows up.
    t = _tournament()
    o = _official("roving_official")
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={"official_id": o["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days",
                    json={"work_date": "2026-06-01", "working_as": "roving_official"}))
    g = _grid(t["id"])
    row = next(r for r in g["officials"] if r["official_id"] == o["id"])
    assert row["available"] == []
    assert row["assigned"] == ["2026-06-01"]


def test_grid_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/availability/grid").status_code == 404
