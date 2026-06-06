"""Roster completeness check (GET .../roster-completeness).

Flags ACTIVE roster entries (selected/alternate) missing data the TD needs
before the event: age division, player gender, t-shirt size, or an outstanding
balance. Withdrawn entries are skipped.

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


def _player(gender="female"):
    body = {"usta_number": str(uuid.uuid4().int % 10**10).zfill(10),
            "first_name": "Comp", "last_name": "P" + uuid.uuid4().hex[:5]}
    if gender:
        body["gender"] = gender
    return _ok(client.post("/api/players", json=body))


def _entry(tid, p, **fields):
    body = {"usta_number": p["usta_number"], "first_name": p["first_name"],
            "last_name": p["last_name"], "gender": p.get("gender") or "female",
            "selection_status": "selected", **fields}
    return _ok(client.post(f"/api/tournaments/{tid}/players", json=body))


def _check(tid):
    return _ok(client.get(f"/api/tournaments/{tid}/roster-completeness"), 200)


def test_complete_entry_not_flagged():
    t = _tournament()
    p = _player()
    _entry(t["id"], p, age_division="G16", t_shirt_size="YM")
    c = _check(t["id"])
    assert c["counts"]["incomplete_entries"] == 0
    assert c["entries"] == []


def test_missing_division_and_shirt_flagged():
    t = _tournament()
    p = _player()
    _entry(t["id"], p)  # no division, no shirt
    c = _check(t["id"])
    assert c["counts"]["incomplete_entries"] == 1
    e = c["entries"][0]
    assert "missing_division" in e["issues"]
    assert "missing_shirt" in e["issues"]
    assert c["counts"]["missing_division"] == 1


def test_withdrawn_entry_excluded():
    t = _tournament()
    p = _player()
    _entry(t["id"], p)  # incomplete...
    # ...but withdraw them → status flips to 'withdrawn' and they drop out of
    # the active completeness check.
    _ok(client.post(f"/api/tournaments/{t['id']}/withdrawals", json={
        "usta_number": p["usta_number"], "first_name": p["first_name"],
        "last_name": p["last_name"], "gender": "female", "reason": "injury"}))
    c = _check(t["id"])
    assert c["counts"]["incomplete_entries"] == 0


def test_alternate_entry_included():
    t = _tournament()
    p = _player()
    _entry(t["id"], p, selection_status="alternate")  # incomplete alternate
    c = _check(t["id"])
    assert c["counts"]["incomplete_entries"] == 1
    assert c["entries"][0]["selection_status"] == "alternate"


def test_check_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/roster-completeness").status_code == 404
