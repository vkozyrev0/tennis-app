"""Persisted inbox extracted fields (audit D9 / migration 0051).

List GETs must read columns, not re-run extractors. Write paths stamp
`detected_text_ready` so legacy-lazy backfill only runs once.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.email_extract import compute_extracted_fields
from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


@pytest.fixture(autouse=True)
def _admin():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def test_compute_extracted_fields_pure():
    f = compute_extracted_fields(
        "Boys' 14 singles and doubles",
        "please add",
        "late_entry",
    )
    assert f["detected_division"] == "B14"
    assert f["detected_events"] == "Singles, Doubles"
    assert f["detected_reason"] is None
    assert f["detected_avoid_day"] is None

    w = compute_extracted_fields(
        "Withdrawal", "Reason: Family emergency.", "withdrawal",
    )
    assert w["detected_reason"] == "Family emergency"


def test_create_stamps_and_list_reads():
    t = _tournament()
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "Girls 16 singles late entry",
        "body": "please add her",
        "from_address": "p@example.com",
    }))
    assert e["detected_division"] == "G16"
    assert e["detected_events"] == "Singles"
    # List returns the same without needing detect first.
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    assert row["detected_division"] == "G16"
    assert row["detected_events"] == "Singles"


def test_update_classification_restamps_reason():
    t = _tournament()
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "please withdraw",
        "body": "Reason: injury — cannot play",
        "from_address": "p@example.com",
    }))
    # Unclassified create → withdrawal-only extractors not applied
    assert e.get("detected_reason") is None
    up = _ok(client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "new", "detected_player_id": None,
    }), 200)
    assert up["classification"] == "withdrawal"
    assert up["detected_reason"] and "injury" in up["detected_reason"].lower()
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    assert row["detected_reason"] == up["detected_reason"]


def test_search_hits_division_and_classification():
    t = _tournament()
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "hello",
        "body": "Boys 12 singles only",
        "from_address": "x@y.com",
    }))
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "late_entry", "status": "new",
        "detected_player_id": None,
    })
    by_div = client.get(f"/api/emails?tournament_id={t['id']}&q=B12").json()
    assert any(m["id"] == e["id"] for m in by_div)
    by_cls = client.get(f"/api/emails?tournament_id={t['id']}&q=late_entry").json()
    assert any(m["id"] == e["id"] for m in by_cls)
