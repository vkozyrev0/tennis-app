"""PDF import auto-detects the player (no per-row "Detect" click).

`_merge_email_pdf` (the emails_pdf merge step) now runs the same player detector
the inbox "Detect" button uses, so a freshly-imported email already carries its
matched player + USTA #.

Tested by calling the merge directly against the test DB: the full PDF path
(pdfplumber → staging → merge) needs a binary PDF fixture and no PDF-writer lib
is installed, so we exercise the merge unit with a real cursor instead. The HTTP
side of the inbox (player/USTA projection) is covered by test_zz_inbox*.

Named to sort last (same rationale as the other test_zz modules)."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.db import get_conn
from app.importer import _merge_email_pdf

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


def _roster(tid, first, last, usta, gender="female", division="G14"):
    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": usta, "first_name": first, "last_name": last,
        "gender": gender, "age_division": division, "selection_status": "selected"}))


def _merge(tid, subject, body, from_address="parent@example.com"):
    """Run the emails_pdf merge for one parsed page against the real DB."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            _merge_email_pdf(cur, tid, {
                "subject": subject, "from_address": from_address, "body": body})
        conn.commit()
    finally:
        conn.close()


def _inbox_row(tid, subject):
    rows = client.get(f"/api/emails?tournament_id={tid}").json()
    return next(m for m in rows if m["subject"] == subject)


def test_pdf_merge_auto_detects_player_by_usta():
    t = _tournament()
    usta = "2005551234"
    _roster(t["id"], "Maria", "Gomez", usta)
    subj = "Withdrawal request " + uuid.uuid4().hex[:6]
    _merge(t["id"], subj, f"USTA #: {usta}. Please withdraw Maria.")
    row = _inbox_row(t["id"], subj)
    assert row["detected_player_id"] is not None
    assert row["detected_player_name"] == "Maria Gomez"
    assert row["detected_usta"] == usta            # matched player's number
    assert row["detected_match_kind"] == "usta"
    assert row["detected_usta_text"] == usta        # also parsed from the email


def test_pdf_merge_auto_detects_by_full_name_in_subject():
    t = _tournament()
    _roster(t["id"], "Liam", "Becker", "2009998888", gender="male", division="B16")
    subj = "Late entry: Liam Becker " + uuid.uuid4().hex[:6]
    _merge(t["id"], subj, "Please add him to the draw.")
    row = _inbox_row(t["id"], subj)
    assert row["detected_player_name"] == "Liam Becker"
    assert row["detected_match_kind"] == "fullname_subject"


def test_pdf_merge_no_roster_match_leaves_player_blank_but_keeps_usta_text():
    t = _tournament()  # empty roster
    subj = "Question " + uuid.uuid4().hex[:6]
    _merge(t["id"], subj, "My USTA #: 2001112223 — am I in?")
    row = _inbox_row(t["id"], subj)
    assert row["detected_player_id"] is None
    assert row["detected_player_name"] in (None, "")
    assert row["detected_usta_text"] == "2001112223"   # still shown in the grid


def test_pdf_merge_still_dedups_and_classifies():
    t = _tournament()
    subj = "WITHDRAWAL REQUEST: dup " + uuid.uuid4().hex[:6]
    _merge(t["id"], subj, "withdraw due to injury")
    _merge(t["id"], subj, "withdraw due to injury")   # same → deduped
    rows = [m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
            if m["subject"] == subj]
    assert len(rows) == 1
    assert rows[0]["classification"] == "withdrawal"
    # body round-trips (encrypted at rest, decrypted on read)
    assert "injury" in (rows[0]["body"] or "")
