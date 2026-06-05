"""Inbox: USTA # parsed from the email text (shown in the grid).

`detected_usta_text` is the USTA # pulled straight from the email body/subject —
surfaced for PDF-imported emails even before (or without) a roster player being
matched. Distinct from `detected_usta`, which is the matched player's number.

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


def _email(tid, subject="", body=""):
    return _ok(client.post("/api/emails", json={
        "tournament_id": tid, "subject": subject, "body": body, "from_address": "x@y.com"}))


def _get(tid, email_id):
    return next(m for m in client.get(f"/api/emails?tournament_id={tid}").json()
                if m["id"] == email_id)


def test_labeled_usta_extracted_without_a_roster_match():
    t = _tournament()
    e = _email(t["id"], subject="Withdrawal request",
               body="Please withdraw. USTA #: 2001234567. Thanks.")
    row = _get(t["id"], e["id"])
    assert row["detected_usta_text"] == "2001234567"
    # no roster player, so the matched-player number stays empty
    assert row["detected_usta"] is None


def test_membership_number_label_variant():
    t = _tournament()
    e = _email(t["id"], subject="Late entry",
               body="My membership number 300999888 — add me to the draw.")
    assert _get(t["id"], e["id"])["detected_usta_text"] == "300999888"


def test_lone_bare_number_is_taken():
    t = _tournament()
    e = _email(t["id"], subject="Re: entry", body="Reference 2009998887 for the player.")
    assert _get(t["id"], e["id"])["detected_usta_text"] == "2009998887"


def test_ambiguous_multiple_bare_numbers_yields_none():
    t = _tournament()
    e = _email(t["id"], subject="Info",
               body="Call 5551234567 or 8009998887 for details.")  # two bare numbers
    assert _get(t["id"], e["id"])["detected_usta_text"] is None


def test_no_number_yields_none():
    t = _tournament()
    e = _email(t["id"], subject="Hello", body="Just checking in, no numbers here.")
    assert _get(t["id"], e["id"])["detected_usta_text"] is None
