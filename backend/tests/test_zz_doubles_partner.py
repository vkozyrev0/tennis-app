"""Doubles partner detection (migration 0041): a doubles email names TWO
players — the detector fills BOTH slots (primary + partner), the inbox list
returns both names, and re-classifying away from doubles clears the partner."""
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


@pytest.fixture()
def duo():
    """A tournament with two distinctly-named rostered players."""
    tag = uuid.uuid4().hex[:6]
    t = _ok(client.post("/api/tournaments", json={
        "name": "DP " + tag, "type": "junior",
        "play_start_date": "2026-10-01", "play_end_date": "2026-10-03"}))
    players = []
    for first, last in (("Maya", f"Quintero{tag}"), ("Zara", f"Hollis{tag}")):
        p = _ok(client.post("/api/players", json={
            "usta_number": str(uuid.uuid4().int)[:10],
            "first_name": first, "last_name": last, "gender": "female"}))
        _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "player_id": p["id"], "selection_status": "selected"}))
        players.append(p)
    return t, players


def _email(t, body, classification="doubles"):
    em = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "Doubles request",
        "from_address": "parent@example.com", "body": body}))
    _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": classification,
        "status": "new", "detected_player_id": None}), 200)
    return em


def test_doubles_email_detects_both_players(duo):
    t, (p1, p2) = duo
    em = _email(t, f"{p1['first_name']} {p1['last_name']} would like to partner "
                   f"with {p2['first_name']} {p2['last_name']} for doubles.")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_partner_id"] == p2["id"]
    assert det["detected_partner_name"] == f"{p2['first_name']} {p2['last_name']}"
    # the inbox list carries both names for the grid
    rows = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    row = next(r for r in rows if r["id"] == em["id"])
    assert row["detected_partner_id"] == p2["id"]
    assert row["detected_partner_name"] == f"{p2['first_name']} {p2['last_name']}"


def test_non_doubles_email_keeps_partner_null(duo):
    t, (p1, p2) = duo
    em = _email(t, f"{p1['first_name']} {p1['last_name']} and "
                   f"{p2['first_name']} {p2['last_name']} mentioned together.",
                classification="withdrawal")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_partner_id"] is None


def test_single_name_doubles_email_has_no_partner(duo):
    t, (p1, _p2) = duo
    em = _email(t, f"{p1['first_name']} {p1['last_name']} wants doubles, "
                   "partner to be assigned randomly please.")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_partner_id"] is None


def test_reclassifying_away_from_doubles_clears_partner(duo):
    t, (p1, p2) = duo
    em = _email(t, f"{p1['first_name']} {p1['last_name']} with "
                   f"{p2['first_name']} {p2['last_name']}")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_partner_id"] == p2["id"]
    upd = _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": "late_entry",
        "status": "new", "detected_player_id": p1["id"]}), 200)
    assert upd["detected_partner_id"] is None


def test_bulk_detect_fills_partner(duo):
    t, (p1, p2) = duo
    em = _email(t, f"{p1['first_name']} {p1['last_name']} requests doubles with "
                   f"{p2['first_name']} {p2['last_name']}")
    out = _ok(client.post("/api/emails/bulk/detect-players",
                          json={"email_ids": [em["id"]]}), 200)
    assert out[0]["detected_player_id"] == p1["id"]
    assert out[0]["detected_partner_id"] == p2["id"]


# ---- pairing-avoidance groups (migration 0042) -------------------------------

@pytest.fixture()
def trio_roster():
    tag = uuid.uuid4().hex[:6]
    t = _ok(client.post("/api/tournaments", json={
        "name": "PG " + tag, "type": "junior",
        "play_start_date": "2026-10-10", "play_end_date": "2026-10-12"}))
    players = []
    for first, last in (("Lena", f"Okafor{tag}"), ("Ruth", f"Castellanos{tag}"),
                        ("Ines", f"Marchetti{tag}")):
        p = _ok(client.post("/api/players", json={
            "usta_number": str(uuid.uuid4().int)[:10],
            "first_name": first, "last_name": last, "gender": "female"}))
        _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "player_id": p["id"], "selection_status": "selected"}))
        players.append(p)
    return t, players


def test_pairing_email_detects_the_whole_group(trio_roster):
    t, (p1, p2, p3) = trio_roster
    em = _email(t, f"Please avoid pairing {p1['first_name']} {p1['last_name']} with "
                   f"{p2['first_name']} {p2['last_name']} or "
                   f"{p3['first_name']} {p3['last_name']} — same club.",
                classification="pairing_avoidance")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_member_ids"] == [p1["id"], p2["id"], p3["id"]]
    assert det["detected_member_names"] == [
        f"{p['first_name']} {p['last_name']}" for p in (p1, p2, p3)]
    rows = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    row = next(r for r in rows if r["id"] == em["id"])
    assert row["detected_member_ids"] == [p1["id"], p2["id"], p3["id"]]
    assert len(row["detected_member_names"]) == 3


def test_single_name_pairing_email_keeps_members_null(trio_roster):
    t, (p1, _p2, _p3) = trio_roster
    em = _email(t, f"{p1['first_name']} {p1['last_name']} asked about pairing rules.",
                classification="pairing_avoidance")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_member_ids"] is None


def test_reclassifying_away_from_pairing_clears_members(trio_roster):
    t, (p1, p2, _p3) = trio_roster
    em = _email(t, f"avoid pairing {p1['first_name']} {p1['last_name']} with "
                   f"{p2['first_name']} {p2['last_name']}",
                classification="pairing_avoidance")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_member_ids"] == [p1["id"], p2["id"]]
    upd = _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "new", "detected_player_id": p1["id"]}), 200)
    assert upd["detected_member_ids"] is None
