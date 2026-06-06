"""Simple roster CSV import (the hand-typed USTA#/name/division/status sheet).

The legacy `roster` importer is now promoted to a first-class Roster-panel
option. These tests pin the behaviour the panel relies on: it's listed by
/import/types, and a simple CSV stages + merges with the age division and
selection status landing on the roster entry.

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


def test_simple_roster_type_is_listed():
    types = {t["key"]: t for t in _ok(client.get("/api/import/types"), 200)}
    assert "roster" in types
    assert "simple" in types["roster"]["label"].lower()
    # the panel relies on these columns being recognised
    for col in ("usta_number", "age_division", "selection_status"):
        assert col in types["roster"]["columns"]


def test_simple_roster_csv_seeds_division_and_status():
    t = _tournament()
    sel = "RC" + uuid.uuid4().hex[:6]
    alt = "RC" + uuid.uuid4().hex[:6]
    csv_data = ("USTA #,First,Last,Gender,Division,Status\n"
                f"{sel},Sam,Selected,F,G16,selected\n"
                f"{alt},Alex,Alt,F,G16,alternate\n")
    up = _ok(client.post(f"/api/import/tournaments/{t['id']}/roster",
                         files={"file": ("roster.csv", csv_data, "text/csv")}))
    assert up["total"] == 2 and up["valid"] == 2
    m = client.post(f"/api/import/batches/{up['batch_id']}/merge").json()
    assert m["merged"] == 2 and m["failed"] == 0
    roster = {e["usta_number"]: e for e in client.get(f"/api/tournaments/{t['id']}/players").json()}
    assert roster[sel]["selection_status"] == "selected"
    assert roster[sel]["age_division"] == "G16"
    assert roster[alt]["selection_status"] == "alternate"
