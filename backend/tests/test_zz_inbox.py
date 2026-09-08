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


def test_detect_off_roster_player_by_usta():
    # A player who exists in the system but is NOT on this tournament's roster:
    # detection still matches by USTA # and flags it with `usta_offroster` so the
    # UI can offer "add to roster".
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": "Off", "last_name": "Roster", "gender": "male"}))
    e = _email(t["id"], subject="Late entry", body=f"Please add USTA {usta} to the draw.")
    d = _detect(e["id"])
    assert d["match_kind"] == "usta_offroster"
    assert d["detected_usta"] == usta
    assert d["detected_player_name"] == "Off Roster"


def test_roster_usta_beats_off_roster():
    # When the USTA # belongs to a ROSTER player, the high-precision roster layer
    # (L1, kind 'usta') wins — off-roster is only a fallback.
    t = _tournament()
    usta = _rostered(t["id"], "On", "Roster", "male", "B14")
    e = _email(t["id"], subject="Q", body=f"USTA {usta} update")
    assert _detect(e["id"])["match_kind"] == "usta"


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
               body="Please withdraw Anna Brown from the tournament due to injury.")
    out = _ok(client.post(f"/api/emails/{e['id']}/suggest", json={}), 200)
    assert out["classification"] == "withdrawal"


def test_suggest_restamps_partner_swap_name_pairs():
    t = _tournament()
    body = (
        "Hi my son name is Ernesto Del Valle. He is schedule to play doubles "
        "this weekend. His double partner is going to withdraw. I talk to "
        "another player. His name is Ulrich Novakovitch. Please let me know "
        "if he can be pair with him so can also play doubles. Thanks."
    )
    e = _email(t["id"], subject="L5 doubles Macon", body=body,
               from_address="ernestodv7@gmail.com")
    out = _ok(client.post(f"/api/emails/{e['id']}/suggest", json={}), 200)
    assert out["classification"] == "doubles"
    names = {(p.get("name") or "").casefold()
             for p in (out.get("detected_name_pairs") or [])}
    assert "ernesto del valle" in names
    assert "ulrich novakovitch" in names
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    listed = {(p.get("name") or "").casefold()
              for p in (row.get("detected_name_pairs") or [])}
    assert "ernesto del valle" in listed
    assert "ulrich novakovitch" in listed


def test_suggest_leftover_fills_players_when_extract_empty(monkeypatch):
    monkeypatch.setenv("EMAIL_LLM", "1")

    def fake_leftover(subject, body):
        return {
            "intent": "doubles",
            "players": [
                {"name": "Jane Roe", "usta": "2018111001"},
                {"name": "Alex Kim", "usta": "2018111002"},
            ],
            "reason": "named pairing",
            "confidence": 0.9,
        }

    monkeypatch.setattr("app.email_llm.leftover_model_intent", fake_leftover)
    monkeypatch.setattr("app.email_llm.llm_enabled", lambda: True)
    t = _tournament()
    e = _email(
        t["id"],
        subject="Boys 14 Doubles",
        body="Please add for doubles. We will try to find a partner.",
    )
    out = _ok(client.post(f"/api/emails/{e['id']}/suggest", json={}), 200)
    assert out["classification"] == "doubles"
    names = {(p.get("name") or "").casefold()
             for p in (out.get("detected_name_pairs") or [])}
    assert names == {"jane roe", "alex kim"}


def test_suggest_leftover_empty_keeps_extract_pairs(monkeypatch):
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setattr(
        "app.email_llm.leftover_model_intent",
        lambda s, b: {"intent": "doubles", "players": [], "reason": None, "confidence": 0.9},
    )
    monkeypatch.setattr("app.email_llm.llm_enabled", lambda: True)
    t = _tournament()
    e = _email(
        t["id"],
        subject="Boys 14 Doubles",
        body="Please add for doubles. We will try to find a partner.",
    )
    out = _ok(client.post(f"/api/emails/{e['id']}/suggest", json={}), 200)
    assert out["classification"] == "doubles"
    assert out.get("detected_name_pairs") == []

    monkeypatch.setattr(
        "app.email_llm.leftover_model_intent",
        lambda s, b: {
            "intent": "doubles",
            "players": [{"name": None, "usta": None}],
            "reason": None,
            "confidence": 0.9,
        },
    )
    e2 = _email(
        t["id"],
        subject="Boys 16 Doubles",
        body="Please add for doubles. We will try to find a partner.",
    )
    out2 = _ok(client.post(f"/api/emails/{e2['id']}/suggest", json={}), 200)
    assert out2.get("detected_name_pairs") == []


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


def test_extract_withdrawal_reason_patterns():
    from app.routers.emails import extract_withdrawal_reason as ex
    # explicit "Reason: X" field (stops at the next labelled field)
    assert ex("Withdrawal Request: David Benedict",
              "Player Name: David Benedict Reason: Injury Round/Event: B14s") == "Injury"
    # "due to <reason>" free text
    assert ex("Withdraw", "…need to withdraw my daughter due to leg injury. Please confirm.") == "leg injury"
    # USTA portal boilerplate ("for the following reason: Please go to…") → none
    assert ex("WITHDRAWAL REQUEST: Anvith",
              "…for the following reason: Please go to the tournament details to withdraw the player.") is None
    # keyword fallback → normalized category
    assert ex("Withdraw", "pulling out, injury") == "Injury"
    assert ex("Withdraw", "she is sick with the flu") == "Illness"
    # nothing extractable
    assert ex("Re: Doubles", "Thanks, see you there") is None


def test_bulk_populate_autofills_withdrawal_reason():
    t = _tournament()
    usta = _rostered(t["id"], "Hurt", "Player", "male", "B14")
    e = _email(t["id"], subject="Withdrawal Request: Hurt Player",
               body=f"Player {usta} must withdraw due to a shoulder injury. Please confirm.")
    pid = _detect(e["id"])["detected_player_id"]
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "new", "detected_player_id": pid,
    })
    _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    wd = next(w for w in client.get(f"/api/tournaments/{t['id']}/withdrawals").json()
              if w.get("usta_number") == usta)
    assert wd["reason"] == "a shoulder injury"


def test_list_emails_exposes_detected_reason_for_withdrawals():
    t = _tournament()
    usta = _rostered(t["id"], "Reason", "Shown", "female", "G14")
    e = _email(t["id"], subject="Reason Shown withdrawal",
               body=f"{usta} — Reason: Family emergency. Round/Event: G14")
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal", "status": "new",
        "detected_player_id": _detect(e["id"])["detected_player_id"],
    })
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    assert row["detected_reason"] == "Family emergency"
    # a non-withdrawal email carries no reason
    e2 = _email(t["id"], subject="General question", body="due to rain we wonder about parking")
    row2 = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
                if m["id"] == e2["id"])
    assert row2["detected_reason"] is None


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


def test_bulk_populate_creates_scheduling_avoidance():
    """Regression: the populate map keyed scheduling as 'scheduling' while the
    stored classification is 'scheduling_avoidance', so every such email was
    silently skipped. The shared registry keeps the keys aligned."""
    t = _tournament()
    usta = _rostered(t["id"], "Sam", "Schedule", "male", "B16")
    e = _email(t["id"], subject="Sam Schedule", body=f"cannot play before 9 {usta}")
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "scheduling_avoidance",
        "status": "new", "detected_player_id": _detect(e["id"])["detected_player_id"],
    })
    res = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    assert res["filed"] == 1, res          # was 0 (skipped) before the registry fix
    rows = client.get(f"/api/tournaments/{t['id']}/scheduling-avoidances").json()
    assert any(r.get("usta_number") == usta for r in rows), rows


def test_bulk_populate_reports_single_file_only_classifications():
    """doubles / pairing can't be bulk-filed (need fields a single email can't
    supply); the action should report them with a clear reason, not crash or
    pretend success."""
    t = _tournament()
    usta = _rostered(t["id"], "Dana", "Doubles", "female", "G14")
    e = _email(t["id"], subject="Dana Doubles", body=f"partner request {usta}")
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": _detect(e["id"])["detected_player_id"],
    })
    res = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    assert res["filed"] == 0
    assert res["skipped"] and "individually" in res["skipped"][0]["reason"], res


def test_file_withdrawal_without_player_does_not_insert():
    t = _tournament()
    e = _email(t["id"], subject="Please withdraw", body="injury, cannot play")
    ok = client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "new", "detected_player_id": None,
    })
    assert ok.status_code == 200, ok.text
    blocked = client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "filed", "detected_player_id": None,
    })
    assert blocked.status_code == 400, blocked.text
    detail = blocked.json()["detail"].lower()
    assert "player" in detail
    assert "will not change" in detail
    wd = client.get(f"/api/tournaments/{t['id']}/withdrawals").json()
    assert not any(r.get("source_email_id") == e["id"] for r in wd)
    dbl = client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "filed", "detected_player_id": None,
    })
    assert dbl.status_code == 400, dbl.text
    assert "will not change" in dbl.json()["detail"].lower()
    doubles = client.get(f"/api/tournaments/{t['id']}/doubles").json()
    rows = list(doubles.get("requests") or []) + list(doubles.get("pairs") or [])
    assert not any(isinstance(r, dict) and r.get("source_email_id") == e["id"] for r in rows)


def test_bulk_status_filed_blocks_playerless_withdrawal_and_doubles():
    from app.email_targets import FILE_NEEDS_PLAYER_REASON
    t = _tournament()
    wd = _email(t["id"], subject="Please withdraw", body="injury, cannot play")
    client.put(f"/api/emails/{wd['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "new", "detected_player_id": None,
    })
    blocked = client.post("/api/emails/bulk/status",
                          json={"email_ids": [wd["id"]], "status": "filed"})
    assert blocked.status_code == 400, blocked.text
    assert "player" in blocked.json()["detail"].lower()
    assert "will not change" in blocked.json()["detail"].lower()
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == wd["id"])
    assert row["status"] == "new"
    wd_list = client.get(f"/api/tournaments/{t['id']}/withdrawals").json()
    assert not any(r.get("source_email_id") == wd["id"] for r in wd_list)
    dbl = _email(t["id"], subject="Boys 14s Doubles Confirmation",
                 body="Scarlett Milner doubles pairing change")
    client.put(f"/api/emails/{dbl['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": None,
    })
    blocked2 = client.post("/api/emails/bulk/status",
                           json={"email_ids": [dbl["id"]], "status": "filed"})
    assert blocked2.status_code == 400, blocked2.text
    assert blocked2.json()["detail"] == FILE_NEEDS_PLAYER_REASON
    hotel = _email(t["id"], subject="Marriott block", body="we are staying at the Marriott")
    client.put(f"/api/emails/{hotel['id']}", json={
        "tournament_id": t["id"], "classification": "hotel",
        "status": "new", "detected_player_id": None,
    })
    ok = _ok(client.post("/api/emails/bulk/status",
                         json={"email_ids": [hotel["id"]], "status": "filed"}), 200)
    assert ok["updated"] == 1
    hotel_row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
                     if m["id"] == hotel["id"])
    assert hotel_row["status"] == "filed"
    mixed = _ok(client.post("/api/emails/bulk/status",
                            json={"email_ids": [wd["id"], hotel["id"]], "status": "filed"}), 200)
    assert mixed["updated"] == 1
    assert mixed["skipped"] and mixed["skipped"][0]["id"] == wd["id"]
    assert mixed["skipped"][0]["reason"] == FILE_NEEDS_PLAYER_REASON
    still_new = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
                     if m["id"] == wd["id"])
    assert still_new["status"] == "new"


def test_bulk_populate_skips_unmatched_withdrawal_and_does_not_insert():
    from app.email_targets import FILE_NEEDS_PLAYER_REASON
    t = _tournament()
    e = _email(t["id"], subject="Please withdraw Jordan Avery",
               body="Please withdraw Jordan Avery from the tournament.")
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal",
        "status": "new", "detected_player_id": None,
    })
    res = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    assert res["filed"] == 0, res
    assert res["skipped"], res
    assert res["skipped"][0]["reason"] == FILE_NEEDS_PLAYER_REASON
    wd = client.get(f"/api/tournaments/{t['id']}/withdrawals").json()
    assert not any(r.get("source_email_id") == e["id"] for r in wd)
    dbl = _email(t["id"], subject="Boys 14s Doubles Confirmation",
                 body="Scarlett Milner doubles pairing change")
    client.put(f"/api/emails/{dbl['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": None,
    })
    res2 = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [dbl["id"]]}), 200)
    assert res2["filed"] == 0, res2
    assert res2["skipped"][0]["reason"] == FILE_NEEDS_PLAYER_REASON
    doubles = client.get(f"/api/tournaments/{t['id']}/doubles").json()
    rows = list(doubles.get("requests") or []) + list(doubles.get("pairs") or [])
    assert not any(isinstance(r, dict) and r.get("source_email_id") == dbl["id"] for r in rows)


def test_suggest_and_bulk_classify_stamp_classified_ms():
    t = _tournament()
    e = _email(t["id"], subject="Withdrawal request for my daughter",
               body="Please withdraw Anna Brown from the tournament due to injury.")
    out = _ok(client.post(f"/api/emails/{e['id']}/suggest", json={}), 200)
    assert out["classification"] == "withdrawal"
    assert isinstance(out["classified_ms"], int)
    assert out["classified_ms"] >= 0
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    assert row["classified_ms"] == out["classified_ms"]
    e2 = _email(t["id"], subject="I missed the deadline", body="can I still enter?")
    bulk = _ok(client.post("/api/emails/bulk/classify",
                           json={"email_ids": [e2["id"]]}), 200)
    assert bulk["classified"] == 1
    assert isinstance(bulk["changed"][0]["classified_ms"], int)
    assert bulk["changed"][0]["classified_ms"] >= 0
    row2 = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
                if m["id"] == e2["id"])
    assert row2["classified_ms"] == bulk["changed"][0]["classified_ms"]


def test_target_registry_is_internally_consistent():
    """Guard against key-drift across layers: every classification triage can
    emit (except 'other') must be a known fileable target, every bulk key must
    be a fileable key, and the public /targets endpoint must match the registry.
    This test fails fast if anyone re-introduces a mismatched key."""
    from app.email_targets import FILEABLE_KEYS, POPULATE_TARGETS, public_targets
    from app.triage import _RULES

    triage_keys = {label for label, _ in _RULES}
    assert triage_keys <= set(FILEABLE_KEYS), (triage_keys - set(FILEABLE_KEYS))
    assert set(POPULATE_TARGETS) <= set(FILEABLE_KEYS)
    # the HTTP contract the frontend consumes mirrors the registry exactly
    api_keys = [t["key"] for t in client.get("/api/emails/targets").json()]
    assert api_keys == FILEABLE_KEYS
    bulk_api = {t["key"] for t in client.get("/api/emails/targets").json() if t["bulk"]}
    assert bulk_api == set(POPULATE_TARGETS)


# --------------------------------------------------------------------------
# Local field extraction (no LLM): age division + events.
# --------------------------------------------------------------------------
def test_extract_age_division_variants():
    from app.routers.emails import extract_age_division as ad
    assert ad("WITHDRAWAL REQUEST: Sid, Boys' 14 & under singles", "") == "B14"
    assert ad("Girls 16 doubles question", "") == "G16"
    assert ad("", "please enter him in B12") == "B12"
    assert ad("re: G 18 draw", "") == "G18"
    # no junior division present → None (adult NTRP not guessed)
    assert ad("NTRP 4.0 Men singles", "") is None
    assert ad("general parking question", "") is None
    # not a junior age → not matched
    assert ad("B11 typo", "") is None


def test_extract_events_variants():
    from app.routers.emails import extract_events as ev
    assert ev("Singles entry", "") == "Singles"
    assert ev("doubles partner", "") == "Doubles"
    assert ev("wants singles and doubles", "") == "Singles, Doubles"
    assert ev("Mixed doubles request", "") == "Mixed Doubles"
    # 'mixed doubles' alone must not also count as plain 'Doubles'
    assert ev("mixed doubles only", "") == "Mixed Doubles"
    assert ev("no event mentioned here", "") is None


def test_inbox_list_surfaces_detected_division_and_events():
    t = _tournament()
    usta = _rostered(t["id"], "Field", "Extract", "male", "B14")
    e = _email(t["id"], subject=f"Boys' 14 singles and doubles — {usta}",
               body="please add him")
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    assert row["detected_division"] == "B14"
    assert row["detected_events"] == "Singles, Doubles"


def test_bulk_populate_carries_division_and_events_into_late_entry():
    """Bulk 'Populate lists' now fills the same parsed fields single-file does."""
    t = _tournament()
    usta = _rostered(t["id"], "Bulk", "Fields", "female", "G16")
    e = _email(t["id"], subject=f"Girls 16 singles late entry — {usta}",
               body="please add her")
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "late_entry",
        "status": "new", "detected_player_id": _detect(e["id"])["detected_player_id"],
    })
    res = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    assert res["filed"] == 1, res
    le = next(r for r in client.get(f"/api/tournaments/{t['id']}/late-entries").json()
              if r.get("usta_number") == usta)
    assert le["age_division"] == "G16"
    assert le["events"] == "Singles"


def test_extract_avoid_day_and_time():
    from app.routers.emails import extract_avoid_day as day, extract_avoid_time as tm
    assert day("can't play Saturday", "") == "Sat"
    assert day("avoid Sat and Sun please", "") == "Sat, Sun"
    assert day("no day mentioned", "") is None
    assert tm("please schedule before 10am", "") == "before 10 am"
    assert tm("after 5 PM only", "") == "after 5 pm"
    assert tm("mornings are hard", "") == "mornings"
    assert tm("no time constraint", "") is None


def test_inbox_surfaces_avoid_fields_only_for_scheduling():
    t = _tournament()
    usta = _rostered(t["id"], "Sked", "Time", "male", "B14")
    e = _email(t["id"], subject=f"{usta} can't play Saturday before 10am", body="thanks")
    # before classification it's 'unclassified' → avoid fields stay null
    pre = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    assert pre["detected_avoid_day"] is None and pre["detected_avoid_time"] is None
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "scheduling_avoidance",
        "status": "new", "detected_player_id": _detect(e["id"])["detected_player_id"],
    })
    row = next(m for m in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if m["id"] == e["id"])
    assert row["detected_avoid_day"] == "Sat"
    assert row["detected_avoid_time"] == "before 10 am"


def test_bulk_populate_carries_avoid_day_and_time():
    t = _tournament()
    usta = _rostered(t["id"], "Sked", "Bulk", "female", "G14")
    e = _email(t["id"], subject=f"{usta} avoid Sunday after 6pm", body="please")
    client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "scheduling_avoidance",
        "status": "new", "detected_player_id": _detect(e["id"])["detected_player_id"],
    })
    res = _ok(client.post("/api/emails/bulk/populate", json={"email_ids": [e["id"]]}), 200)
    assert res["filed"] == 1, res
    row = next(r for r in client.get(f"/api/tournaments/{t['id']}/scheduling-avoidances").json()
               if r.get("usta_number") == usta)
    assert row["avoid_day"] == "Sun"
    assert row["avoid_time_range"] == "after 6 pm"


def test_clear_inbox_deletes_only_that_tournament():
    a = _tournament()
    b = _tournament()
    ea = _email(a["id"], subject="Keep-out A " + uuid.uuid4().hex[:6])
    eb = _email(b["id"], subject="Keep B " + uuid.uuid4().hex[:6])
    missing = client.post("/api/emails/clear?tournament_id=99999991")
    assert missing.status_code == 404
    r = client.post(f"/api/emails/clear?tournament_id={a['id']}")
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] >= 1
    left_a = client.get(f"/api/emails?tournament_id={a['id']}").json()
    left_b = client.get(f"/api/emails?tournament_id={b['id']}").json()
    assert all(e["id"] != ea["id"] for e in left_a)
    assert any(e["id"] == eb["id"] for e in left_b)


def test_clear_inbox_soft_deletes_and_ingest_restores():
    """Clear hides the row; ingest of the same message_id un-hides it."""
    from app.db import get_conn
    from app.email_ingest import IngestPayload, ingest_email
    t = _tournament()
    mid = f"<hide-{uuid.uuid4().hex}@mail.test>"
    row = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "message_id": mid,
        "from_address": "parent@example.com",
        "subject": "Boys 14 Withdrawal", "body": "please withdraw",
    }))
    client.post(f"/api/emails/clear?tournament_id={t['id']}")
    listed = client.get(f"/api/emails?tournament_id={t['id']}").json()
    assert all(e["id"] != row["id"] for e in listed)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT deleted_at, tournament_id FROM email_message WHERE id = %s",
                (row["id"],),
            )
            hidden = cur.fetchone()
            assert hidden["deleted_at"] is not None
            assert hidden["tournament_id"] == t["id"]
            result = ingest_email(cur, IngestPayload(
                message_id=mid,
                from_address="parent@example.com",
                to_address="td@example.com",
                subject="Boys 14 Withdrawal",
                body="please withdraw",
                tournament_id=t["id"],
                ingest_source="outlook",
            ))
        conn.commit()
    assert result["duplicate"] is False
    assert result["id"] == row["id"]
    shown = client.get(f"/api/emails?tournament_id={t['id']}").json()
    assert any(e["id"] == row["id"] for e in shown)


def test_get_all_restores_hidden_when_feeds_skipped():
    t = _tournament()
    e = _email(t["id"], subject="hidden " + uuid.uuid4().hex[:6], body="please")
    client.put("/api/gmail-feed", json={"enabled": False})
    client.put("/api/outlook-feed", json={"enabled": False, "mailbox": "TD@myadllc.com"})
    client.post(f"/api/emails/clear?tournament_id={t['id']}")
    empty = client.get(f"/api/emails?tournament_id={t['id']}").json()
    assert all(x["id"] != e["id"] for x in empty)
    skipped = client.post(f"/api/inbox-feeds/fetch?tournament_id={t['id']}")
    assert skipped.status_code == 200, skipped.text
    assert (skipped.json().get("restored") or 0) == 0
    still = client.get(f"/api/emails?tournament_id={t['id']}").json()
    assert all(x["id"] != e["id"] for x in still)
    r = client.post(f"/api/inbox-feeds/fetch?tournament_id={t['id']}&get_all=true")
    assert r.status_code == 200, r.text
    assert r.json()["restored"] >= 1
    assert r.json()["imported"] >= 1
    listed = client.get(f"/api/emails?tournament_id={t['id']}").json()
    assert any(x["id"] == e["id"] for x in listed)


def test_clear_inbox_is_local_sql_only():
    """Clear must not call Gmail IMAP or Microsoft Graph — mailbox mail stays."""
    import inspect
    from app.routers import emails as emails_mod
    src = inspect.getsource(emails_mod.clear_inbox)
    assert "deleted_at" in src
    assert "DELETE FROM email_message" not in src
    assert "gmail_feed" not in src
    assert "outlook_feed" not in src
    assert "imaplib" not in src
    assert "graph.microsoft.com" not in src


def test_populate_extract_names_have_extractors():
    """Every `extract` field declared in the registry must have a matching
    extractor function, or bulk_populate would KeyError at runtime."""
    from app.email_targets import POPULATE_TARGETS
    from app.routers.emails import _EXTRACTORS
    declared = {name for t in POPULATE_TARGETS.values() for name in t.get("extract", [])}
    assert declared <= set(_EXTRACTORS), (declared - set(_EXTRACTORS))
