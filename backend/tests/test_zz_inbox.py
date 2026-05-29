"""Inbox + player-detection backend tests.

Covers the work added this session:
- the layered `_detect_player_for` cascade (USTA #, full name in subject,
  USTA-portal withdrawal templates, unique surname, no-match)
- match_kind persistence + the PUT semantics (preserve on reclassify, tag
  'manual' on hand-pick, clear when the player is unset) — this is the path
  that regressed with a 500 (untyped NULL param)
- the /suggest classification endpoint
- bulk detect / reassign / populate

Requires a migrated + seeded courtops_test DB (conftest handles it).
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
# NOTE: do NOT log in at import time. Every /auth/login deletes all other
# sessions for that user (auth.py — single-session-per-user), so an import-time
# admin login here would kill the session another test module established at
# its own import. The autouse fixture below logs in lazily before each test,
# and the file is named to sort last so its logins never pre-empt a module
# that's still running.

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


@pytest.fixture(autouse=True)
def _ensure_admin_session():
    """Other test modules log in as admin too; depending on collection order a
    later module's login can invalidate the session this module established at
    import time. Re-establish it before every test so the suite is order-proof."""
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _tournament(**kw):
    body = {"name": "T " + uuid.uuid4().hex[:6], "type": "junior",
            "play_start_date": "2026-06-01", "play_end_date": "2026-06-04", **kw}
    return _ok(client.post("/api/tournaments", json=body))


def _rostered(tid, first, last, gender, division, usta=None):
    """Create a player inline on the roster (carries gender + division).

    USTA #s are numeric 10-digit so they match the detector's \\d{9,11} rule.
    """
    usta = usta or str(uuid.uuid4().int % 10**10).zfill(10)
    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": usta, "first_name": first, "last_name": last,
        "gender": gender, "age_division": division, "selection_status": "selected",
    }))
    return usta


def _email(tid, subject="", body="", from_address=""):
    return _ok(client.post("/api/emails", json={
        "tournament_id": tid, "subject": subject, "body": body,
        "from_address": from_address,
    }))


def _detect(email_id):
    return _ok(client.post(f"/api/emails/{email_id}/detect-player", json={}), 200)


# --------------------------------------------------------------------------
# Detection cascade — each layer in isolation, plus the no-match floor.
# --------------------------------------------------------------------------
def test_detect_by_usta_number_in_body():
    t = _tournament()
    usta = _rostered(t["id"], "Reetisha", "Phukan", "female", "G14")
    e = _email(t["id"], subject="Question", body=f"Player USTA {usta} has a conflict.")
    d = _detect(e["id"])
    assert d["detected_usta"] == usta
    assert d["match_kind"] == "usta"
    assert d["detected_player_name"] == "Reetisha Phukan"


def test_detect_by_fullname_in_subject():
    t = _tournament()
    _rostered(t["id"], "Vera", "Pantovic", "female", "G14")
    e = _email(t["id"], subject="Vera Pantovic doubles change",
               from_address="A Parent", body="see subject")
    d = _detect(e["id"])
    assert d["detected_player_name"] == "Vera Pantovic"
    assert d["match_kind"] == "fullname_subject"


def test_detect_by_withdrawal_body_template():
    """USTA portal body line, name NOT in subject → withdraw_template layer."""
    t = _tournament()
    _rostered(t["id"], "Anvith", "Chamarthi", "male", "B14")
    e = _email(
        t["id"],
        subject="WITHDRAWAL REQUEST: confirmation",
        body="Dear Julie, Anvith Chamarthi has requested to be withdrawn from the event.",
    )
    d = _detect(e["id"])
    assert d["detected_player_name"] == "Anvith Chamarthi"
    assert d["match_kind"] == "withdraw_template"


def test_detect_by_usta_subject_template_first_name_only():
    """USTA subject template: first name + Boys'/Girls' + age, body has no
    surname. Unique roster match on (first, gender, division) wins."""
    t = _tournament()
    _rostered(t["id"], "Siddhanth", "Matharambeti", "male", "B14")
    # a decoy with the same first name but different gender/division must NOT
    # break uniqueness for the boys' 14 query.
    _rostered(t["id"], "Siddhanth", "Other", "female", "G16")
    e = _email(
        t["id"],
        subject="WITHDRAWAL REQUEST: Siddhanth, Boys' 14 & under singles",
        body="Withdrawal Request",
    )
    d = _detect(e["id"])
    assert d["detected_player_name"] == "Siddhanth Matharambeti"
    assert d["match_kind"] == "usta_subject"


def test_detect_unique_surname_in_sender():
    """Surname only (e.g. in the From), unique on the roster → lastname."""
    t = _tournament()
    _rostered(t["id"], "Drew", "Hudgens", "male", "B14")
    e = _email(t["id"], subject="Re: Boys 14 doubles",
               from_address="Sara Hudgens", body="thanks!")
    d = _detect(e["id"])
    assert d["detected_player_name"] == "Drew Hudgens"
    assert d["match_kind"] == "lastname"


def test_detect_ambiguous_surname_returns_none():
    """Two roster players share a surname → detector abstains (no wrong tag)."""
    t = _tournament()
    _rostered(t["id"], "Alex", "Smith", "male", "B14")
    _rostered(t["id"], "Bella", "Smith", "female", "G14")
    e = _email(t["id"], subject="Re: Smith doubles", body="the Smith kids")
    d = _detect(e["id"])
    assert d["detected_player_id"] is None
    assert d["match_kind"] is None


def test_detect_no_match():
    t = _tournament()
    _rostered(t["id"], "Real", "Player", "male", "B14")
    e = _email(t["id"], subject="General question about parking", body="no names here")
    d = _detect(e["id"])
    assert d["detected_player_id"] is None


def test_detect_priority_usta_beats_other_signals():
    """A USTA # match wins even when another player's surname is also present."""
    t = _tournament()
    usta = _rostered(t["id"], "Kate", "Hampton", "female", "G14")
    _rostered(t["id"], "Zoe", "Hampton", "female", "G16")  # shares surname
    e = _email(t["id"], subject="Hampton doubles", body=f"USTA {usta}")
    d = _detect(e["id"])
    # subject "Hampton" is ambiguous (two Hamptons) but the USTA # in the body
    # is definitive → Kate, kind usta.
    assert d["detected_usta"] == usta
    assert d["match_kind"] == "usta"


# --------------------------------------------------------------------------
# match_kind persistence + PUT semantics (the 500-regression path).
# --------------------------------------------------------------------------
def test_match_kind_persists_in_list():
    t = _tournament()
    usta = _rostered(t["id"], "Persist", "Test", "male", "B14")
    e = _email(t["id"], subject="Persist Test withdrawal", body=f"{usta}")
    _detect(e["id"])
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    assert row["detected_match_kind"] == "usta"
    assert row["detected_player_name"] == "Persist Test"


def test_put_reclassify_preserves_detected_player():
    """Regression: a classification-only PUT must NOT drop the detected player
    or relabel an auto match_kind."""
    t = _tournament()
    usta = _rostered(t["id"], "Keep", "Mine", "male", "B14")
    e = _email(t["id"], subject="Keep Mine", body=f"{usta}")
    d = _detect(e["id"])
    pid = d["detected_player_id"]
    # classification-only change, sending the SAME player back
    r = client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "new", "detected_player_id": pid,
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["detected_player_id"] == pid
    assert out["detected_match_kind"] == "usta"  # not relabelled to 'manual'


def test_put_manual_pick_tags_manual_then_clear():
    t = _tournament()
    usta_a = _rostered(t["id"], "Auto", "Detected", "male", "B14")
    usta_b = _rostered(t["id"], "Hand", "Picked", "female", "G14")
    e = _email(t["id"], subject="Auto Detected", body=f"{usta_a}")
    _detect(e["id"])  # → Auto Detected / usta
    # find player B's id
    players = client.get(f"/api/tournaments/{t['id']}/players").json()
    pid_b = next(p["player_id"] for p in players if p["usta_number"] == usta_b)
    # hand-pick a DIFFERENT player → manual
    out = _ok(client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": pid_b,
    }), 200)
    assert out["detected_player_name"] == "Hand Picked"
    assert out["detected_match_kind"] == "manual"
    # clear the player → kind cleared too (this is the NULL-param path that 500'd)
    out2 = _ok(client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": None,
    }), 200)
    assert out2["detected_player_id"] is None
    assert out2["detected_match_kind"] is None


# --------------------------------------------------------------------------
# Suggest + bulk endpoints.
# --------------------------------------------------------------------------
def test_suggest_classification():
    t = _tournament()
    e = _email(t["id"], subject="Withdrawal request for my daughter",
               body="She must withdraw from the tournament due to injury.")
    out = _ok(client.post(f"/api/emails/{e['id']}/suggest", json={}), 200)
    assert out["classification"] == "withdrawal"


def test_bulk_detect_and_reassign():
    t1, t2 = _tournament(), _tournament()
    usta = _rostered(t1["id"], "Bulk", "Detect", "male", "B14")
    e1 = _email(t1["id"], subject="Bulk Detect", body=f"{usta}")
    e2 = _email(t1["id"], subject="No one here", body="nothing")
    res = _ok(client.post("/api/emails/bulk/detect-players",
                          json={"email_ids": [e1["id"], e2["id"]]}, ), 200)
    by_id = {r["email_id"]: r for r in res}
    assert by_id[e1["id"]]["match_kind"] == "usta"
    assert by_id[e2["id"]]["detected_player_id"] is None
    # reassign both to t2
    rr = _ok(client.post("/api/emails/bulk/reassign",
                         json={"email_ids": [e1["id"], e2["id"]], "tournament_id": t2["id"]}), 200)
    assert rr["updated"] == 2
    assert all(m["tournament_id"] == t2["id"]
               for m in client.get(f"/api/emails?tournament_id={t2['id']}").json())


def test_bulk_populate_creates_withdrawal():
    t = _tournament()
    usta = _rostered(t["id"], "Will", "Withdraw", "male", "B14")
    e = _email(t["id"], subject="Will Withdraw", body=f"please withdraw {usta}")
    _detect(e["id"])
    # classify as withdrawal so populate has a target list
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "new", "detected_player_id": _detect(e["id"])["detected_player_id"],
    })
    res = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    assert res["filed"] == 1, res
    # a withdrawal row now exists for that player
    wds = client.get(f"/api/tournaments/{t['id']}/withdrawals").json()
    assert any(w.get("usta_number") == usta for w in wds), wds
