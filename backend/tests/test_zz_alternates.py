"""Alternate suggestions for promote-on-withdrawal.

`GET /api/tournaments/{id}/alternates?age_division=` lists alternate roster
entries, optionally filtered to one division and ordered FIFO (first added =
next in line), feeding the "a player withdrew — promote an alternate" helper.

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


def _player():
    return _ok(client.post("/api/players", json={
        "usta_number": str(uuid.uuid4().int % 10**10).zfill(10),
        "first_name": "Alt", "last_name": "P" + uuid.uuid4().hex[:5], "gender": "female"}))


def _entry(tid, division, status):
    p = _player()
    e = _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": p["usta_number"], "first_name": p["first_name"],
        "last_name": p["last_name"], "gender": "female", "age_division": division,
        "selection_status": status}))
    return e


def _alternates(tid, division=None):
    url = f"/api/tournaments/{tid}/alternates"
    if division:
        url += f"?age_division={division}"
    return _ok(client.get(url), 200)


def test_only_alternates_returned():
    t = _tournament()
    _entry(t["id"], "G16", "selected")
    alt = _entry(t["id"], "G16", "alternate")
    out = _alternates(t["id"])
    ids = [e["id"] for e in out]
    assert alt["id"] in ids
    assert all(e["selection_status"] == "alternate" for e in out)


def test_division_filter():
    t = _tournament()
    a16 = _entry(t["id"], "G16", "alternate")
    _entry(t["id"], "G18", "alternate")
    out = _alternates(t["id"], "G16")
    assert [e["id"] for e in out] == [a16["id"]]


def test_fifo_order():
    t = _tournament()
    first = _entry(t["id"], "G14", "alternate")
    second = _entry(t["id"], "G14", "alternate")
    out = _alternates(t["id"], "G14")
    assert [e["id"] for e in out] == [first["id"], second["id"]]


def test_empty_when_no_alternates():
    t = _tournament()
    _entry(t["id"], "G12", "selected")
    assert _alternates(t["id"], "G12") == []
