"""REAL-DATA fixture test: `tests/fixtures/tournament_emails.pdf` is an actual
"Tournament Emails for CourtOps" export (the TD's genuine inbox thread dump).
It exercises the full PDF email path — pdfplumber parse → triage → pair
detection — against the messy shapes real parents write (quoted reply chains,
names only / no USTA numbers, glyph-quadrupled labels)."""
from pathlib import Path

import pytest
import uuid

from fastapi.testclient import TestClient

from app.db import get_conn
from app.importer import _merge_email_pdf, _parse_pdf_emails
from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)

_PDF = Path(__file__).parent / "fixtures" / "tournament_emails.pdf"


@pytest.fixture(autouse=True)
def _ensure_admin_session():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


@pytest.fixture(scope="module")
def parsed():
    return _parse_pdf_emails(_PDF.read_bytes())


def test_parses_every_email_with_subject_and_body(parsed):
    assert len(parsed) == 30
    for r in parsed:
        d = r["data"]
        assert d["subject"].strip(), f"page {r['row_num']} lost its subject"
        assert len(d["body"]) > 20, f"page {r['row_num']} lost its body"
    subjects = " | ".join(r["data"]["subject"] for r in parsed)
    # known threads from the real export (incl. deglyphed PDF labels)
    assert "Confirmed partnership" in subjects
    assert "WITHDRAWAL REQUEST: Siddhanth" in subjects
    assert "Macon L3 Doubles" in subjects


def test_real_doubles_email_detects_pair_with_ustas(parsed):
    """'Confirmed partnership' names two girls (no USTA #s in the text) — with
    both on the roster, import must triage it 'doubles' and link BOTH players,
    whose USTA numbers then surface from their roster records."""
    page = next(r["data"] for r in parsed if r["data"]["subject"] == "Confirmed partnership")
    t = _ok(client.post("/api/tournaments", json={
        "name": "PDF " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-04", "play_end_date": "2026-06-09"}))
    players = {}
    for first, last in (("Everly", "Cogdell"), ("Zaria", "Wadawu")):
        p = _ok(client.post("/api/players", json={
            "usta_number": str(uuid.uuid4().int)[:10],
            "first_name": first, "last_name": last, "gender": "female"}))
        _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "player_id": p["id"], "selection_status": "selected"}))
        players[last] = p

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            note = _merge_email_pdf(cur, t["id"], page)
        conn.commit()
    finally:
        conn.close()
    assert note is None or "skipped" not in str(note)

    rows = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    em = next(r for r in rows if r["subject"] == "Confirmed partnership")
    assert em["classification"] == "doubles"
    assert em["detected_player_id"] in (players["Cogdell"]["id"], players["Wadawu"]["id"])
    assert em["detected_partner_id"] in (players["Cogdell"]["id"], players["Wadawu"]["id"])
    assert em["detected_partner_id"] != em["detected_player_id"]
    # BOTH USTA numbers surface (from the roster records — the email has none)
    got = {em["detected_usta"], em["detected_partner_usta"]}
    assert got == {players["Cogdell"]["usta_number"], players["Wadawu"]["usta_number"]}


def test_usta_portal_withdrawal_template_detected(parsed):
    """'WITHDRAWAL REQUEST: Siddhanth, Boys' 14 & under singles' — the portal
    subject template (first name + gender + division, no surname) resolves via
    the L5 layer when exactly one rostered boy fits."""
    page = next(r["data"] for r in parsed
                if r["data"]["subject"].startswith("WITHDRAWAL REQUEST: Siddhanth"))
    t = _ok(client.post("/api/tournaments", json={
        "name": "PDFW " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-04", "play_end_date": "2026-06-09"}))
    p = _ok(client.post("/api/players", json={
        "usta_number": str(uuid.uuid4().int)[:10],
        "first_name": "Siddhanth", "last_name": "R" + uuid.uuid4().hex[:5],
        "gender": "male"}))
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected", "age_division": "B14"}))

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            _merge_email_pdf(cur, t["id"], page)
        conn.commit()
    finally:
        conn.close()

    rows = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    em = next(r for r in rows if "Siddhanth" in r["subject"])
    assert em["classification"] == "withdrawal"
    assert em["detected_player_id"] == p["id"]
