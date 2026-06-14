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


def test_doubles_partner_with_middle_initial_is_matched(duo):
    # Middle initials break the exact-substring layers ("Maya R. Quintero" does
    # NOT contain "Maya Quintero"); the normalized fuzzy layer still pairs both.
    t, (p1, p2) = duo
    em = _email(t, f"Doubles: {p1['first_name']} R. {p1['last_name']} "
                   f"& {p2['first_name']} M. {p2['last_name']}, thanks!")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_partner_id"] == p2["id"]


def test_doubles_partner_last_first_inversion_is_matched(duo):
    # "Surname, First" for BOTH players, no USTA #s — order-independent fuzzy
    # tokens resolve each side.
    t, (p1, p2) = duo
    em = _email(t, f"Doubles pairing — {p1['last_name']}, {p1['first_name']} "
                   f"and {p2['last_name']}, {p2['first_name']}.")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert {det["detected_player_id"], det["detected_partner_id"]} == {p1["id"], p2["id"]}


def test_doubles_partner_accented_and_apostrophe_names():
    # Roster carries accents + an apostrophe; the email writes the de-accented,
    # apostrophe-free forms (how a parent often types them). Fuzzy folds both.
    tag = uuid.uuid4().hex[:6]
    t = _ok(client.post("/api/tournaments", json={
        "name": "DPa " + tag, "type": "junior",
        "play_start_date": "2026-10-01", "play_end_date": "2026-10-03"}))
    ids = []
    for first, last in (("Renée", f"O'Brien{tag}"), ("Zoë", f"Müller{tag}")):
        p = _ok(client.post("/api/players", json={
            "usta_number": str(uuid.uuid4().int)[:10],
            "first_name": first, "last_name": last, "gender": "female"}))
        _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "player_id": p["id"], "selection_status": "selected"}))
        ids.append(p["id"])
    em = _email(t, f"Doubles request: Renee OBrien{tag} would like to play "
                   f"with Zoe Muller{tag} this weekend.")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert {det["detected_player_id"], det["detected_partner_id"]} == set(ids)


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


# ---- USTA numbers in the email text (may cover one player, both, or neither) --

def test_doubles_pair_matches_by_usta_numbers_alone(duo):
    """Both numbers, NO names — the pair resolves entirely via USTA match."""
    t, (p1, p2) = duo
    em = _email(t, f"Please pair {p1['usta_number']} with {p2['usta_number']} for doubles.")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_partner_id"] == p2["id"]
    assert det["detected_partner_usta"] == p2["usta_number"]


def test_doubles_text_keeps_both_numbers_when_unmatched(duo):
    """Two numbers for players NOT on the roster: nobody matches, but BOTH
    numbers surface in detected_usta_text (the old single-number extractor
    gave up on multiple bare numbers)."""
    t, _players = duo
    em = _email(t, "New pair: 2188800001 with 2188800002, both registering for doubles.")
    rows = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    row = next(r for r in rows if r["id"] == em["id"])
    assert row["detected_player_id"] is None
    assert row["detected_usta_text"] == "2188800001, 2188800002"


def test_doubles_mixed_one_matched_one_text_only(duo):
    """A number for the rostered player + a number for an unknown partner: the
    rostered one matches; the stranger's number still surfaces in the text."""
    t, (p1, _p2) = duo
    em = _email(t, f"Pair {p1['usta_number']} with 2188800003 please (doubles).")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_partner_id"] is None        # stranger isn't rostered
    rows = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    row = next(r for r in rows if r["id"] == em["id"])
    assert "2188800003" in (row["detected_usta_text"] or "")


def test_doubles_name_only_surfaces_both_even_when_partner_unrostered():
    """The real failing case: a name-only doubles request ("X and Y would like
    to pair up") where the partner isn't on the roster. The requester matches;
    the partner can't (not rostered), but BOTH names surface in
    detected_name_pairs so the grid still shows the pair for the TD to add."""
    tag = uuid.uuid4().hex[:6]
    t = _ok(client.post("/api/tournaments", json={
        "name": "NameOnly " + tag, "type": "junior",
        "play_start_date": "2026-05-01", "play_end_date": "2026-05-03"}))
    # only the requester is rostered
    p = _ok(client.post("/api/players", json={
        "usta_number": str(uuid.uuid4().int)[:10],
        "first_name": "Mia", "last_name": f"Langone{tag}", "gender": "female"}))
    _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
        "player_id": p["id"], "selection_status": "selected"}))
    em = _email(t, f"Hi there,\nMia Langone{tag} and Chelsea Ie{tag} would like to "
                   "pair up for doubles please.\nThanks!")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p["id"]          # requester matched
    rows = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    row = next(r for r in rows if r["id"] == em["id"])
    names = [pr["name"] for pr in (row["detected_name_pairs"] or [])]
    assert f"Mia Langone{tag}" in names
    assert f"Chelsea Ie{tag}" in names                    # the unrostered partner still shows


def test_doubles_pair_across_lines_with_labels(duo):
    """The TD's real PDF shape: each player on a line as '<name> <skip> USTA# <n>'.
    Both numbers bind to their names across the line breaks + labels, so both
    players resolve."""
    t, (p1, p2) = duo
    em = _email(t, f"Doubles entry\n"
                   f"Player 1: {p1['first_name']} {p1['last_name']} — USTA#: {p1['usta_number']}\n"
                   f"Player 2: {p2['first_name']} {p2['last_name']} — USTA#: {p2['usta_number']}\n")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_partner_id"] == p2["id"]


def test_doubles_pair_number_first_parenthesized(duo):
    """'(<number>) <name>' for both, separated only by punctuation/space."""
    t, (p1, p2) = duo
    em = _email(t, f"Pairing: ({p1['usta_number']}) {p1['first_name']} {p1['last_name']} "
                   f"/ ({p2['usta_number']}) {p2['first_name']} {p2['last_name']}")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p1["id"]
    assert det["detected_partner_id"] == p2["id"]


def test_first_mentioned_number_is_primary(duo):
    """The TD's real format: '<usta> <name>' twice — the FIRST-mentioned pair is
    the requester (primary), the second is the partner; roster iteration order
    must not decide."""
    t, (p1, p2) = duo
    # mention p2 FIRST (number-before-name, unlabeled) -> p2 must be primary
    em = _email(t, f"{p2['usta_number']} {p2['first_name']} {p2['last_name']} "
                   f"requests doubles with {p1['usta_number']} "
                   f"{p1['first_name']} {p1['last_name']}")
    det = _ok(client.post(f"/api/emails/{em['id']}/detect-player"), 200)
    assert det["detected_player_id"] == p2["id"]
    assert det["detected_partner_id"] == p1["id"]


# ---- manual assignment from the inbox grid (Player 2 / USTA #2 columns) ------

def test_manual_partner_assignment_persists(duo):
    t, (p1, p2) = duo
    em = _email(t, "Doubles request but no names the detector can use.")
    upd = _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": "doubles", "status": "new",
        "detected_player_id": p1["id"], "detected_partner_id": p2["id"]}), 200)
    assert upd["detected_player_id"] == p1["id"]
    assert upd["detected_partner_id"] == p2["id"]
    rows = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    row = next(r for r in rows if r["id"] == em["id"])
    assert row["detected_partner_id"] == p2["id"]
    assert row["detected_partner_name"] == f"{p2['first_name']} {p2['last_name']}"
    assert row["detected_partner_usta"] == p2["usta_number"]


def test_manual_partner_survives_any_classification(duo):
    # The TD's manual pick wins even off the doubles classification — e.g. a
    # withdrawal email naming two players. Only clearing the primary clears it.
    t, (p1, p2) = duo
    em = _email(t, "two players withdrawing", classification="withdrawal")
    upd = _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": "withdrawal", "status": "new",
        "detected_player_id": p1["id"], "detected_partner_id": p2["id"]}), 200)
    assert upd["detected_partner_id"] == p2["id"]


def test_clearing_primary_clears_manual_partner(duo):
    t, (p1, p2) = duo
    em = _email(t, "doubles, both manually assigned")
    _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": "doubles", "status": "new",
        "detected_player_id": p1["id"], "detected_partner_id": p2["id"]}), 200)
    upd = _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": "doubles", "status": "new",
        "detected_player_id": None, "detected_partner_id": p2["id"]}), 200)
    assert upd["detected_player_id"] is None
    assert upd["detected_partner_id"] is None


def test_put_without_partner_field_clears_it(duo):
    # Old clients / the detail pane always send the partner explicitly; a body
    # that omits it behaves like the other detected_* fields (reset to NULL).
    t, (p1, p2) = duo
    em = _email(t, "doubles, both manually assigned")
    _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": "doubles", "status": "new",
        "detected_player_id": p1["id"], "detected_partner_id": p2["id"]}), 200)
    upd = _ok(client.put(f"/api/emails/{em['id']}", json={
        "tournament_id": t["id"], "classification": "doubles", "status": "new",
        "detected_player_id": p1["id"]}), 200)
    assert upd["detected_partner_id"] is None
