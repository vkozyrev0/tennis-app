"""UNIT tests for the pure email-text extractors (app/email_extract.py,
plan P2 #9) — no DB, no HTTP. The withdrawal-reason patterns also have
corpus-style coverage in test_zz_inbox.py; these pin each extractor's contract
directly (incl. the conservative give-up paths)."""
from app.email_extract import (
    extract_age_division,
    extract_avoid_day,
    extract_avoid_time,
    extract_events,
    extract_names,
    extract_usta,
    extract_withdrawal_reason,
)


# ------------------------------------------------------------------ USTA # ----
def test_usta_labeled_beats_bare():
    assert extract_usta("", "USTA #: 2104387100 ... call 4045551234567") == "2104387100"


def test_usta_single_bare_run():
    assert extract_usta("Withdrawal", "Member 2104387100 is sick") == "2104387100"


def test_usta_ambiguous_bare_numbers_give_up():
    assert extract_usta("", "ids 2104387100 and 2104387101") is None


def test_usta_none_when_absent():
    assert extract_usta("hello", "no numbers here") is None


# ---------------------------------------------------------------- division ----
def test_division_usta_wording_and_code():
    assert extract_age_division("WITHDRAWAL: Boys' 14 & under", "") == "B14"
    assert extract_age_division("", "entering G 16 singles") == "G16"


def test_division_only_junior_ladder():
    assert extract_age_division("", "B 11 maybe?") is None
    assert extract_age_division("", "adult 4.0 NTRP") is None


# ------------------------------------------------------------------ events ----
def test_events_mixed_not_double_counted():
    assert extract_events("", "singles and mixed doubles please") == "Singles, Mixed Doubles"
    assert extract_events("", "doubles only") == "Doubles"
    assert extract_events("", "nothing relevant") is None


# ------------------------------------------------------------------ reason ----
def test_reason_field_then_due_to_then_keyword():
    assert extract_withdrawal_reason("", "Reason: family emergency\nRound: 1") == "family emergency"
    assert extract_withdrawal_reason("", "must withdraw due to leg injury.") == "leg injury"
    assert extract_withdrawal_reason("", "she has been sick all week") == "Illness"
    assert extract_withdrawal_reason("", "no clue given") is None


def test_reason_skips_portal_boilerplate():
    body = ("requested to be withdrawn for the following reason: \n"
            "Please go to the portal to confirm.")
    assert extract_withdrawal_reason("", body) is None


# --------------------------------------------------------- avoid day / time ----
def test_avoid_day_abbreviations():
    assert extract_avoid_day("", "can't play Saturday or sun morning") == "Sat, Sun"
    assert extract_avoid_day("", "any day works") is None


def test_avoid_time_clause_beats_daypart():
    assert extract_avoid_time("", "not before 10:30 AM mornings") == "before 10:30 am"
    assert extract_avoid_time("", "prefers mornings") == "mornings"
    assert extract_avoid_time("", "whenever") is None


def test_extract_ustas_multiple_numbers():
    from app.email_extract import extract_ustas
    # both players' numbers in one doubles email
    assert extract_ustas("", "Pair Ava (USTA 2104387100) with Mia, USTA # 2105923400") == [
        "2104387100", "2105923400"]
    # bare runs kept in order, deduped
    assert extract_ustas("", "ids 2104387100 and 2105923400 and 2104387100") == [
        "2104387100", "2105923400"]
    # formatted phone numbers don't qualify as bare runs
    assert extract_ustas("", "call 732.429.0529 or 404-555-1234") == []
    # capped — a wall of digits is noise
    assert len(extract_ustas("", " ".join(str(2104387100 + i) for i in range(9)))) == 3
    assert extract_ustas("", "no numbers") == []


def test_usta_number_before_name_pattern():
    """The TD's real-world format: USTA # immediately BEFORE the player's name
    (subject or body) — unlabeled 8-digit numbers qualify via the adjacency."""
    from app.email_extract import extract_ustas, usta_candidates
    # two unlabeled 8-digit numbers, each before a name (the doubles shape)
    assert extract_ustas("Doubles request",
                         "21043871 Ethan Carter with 21059234 Liam Anderson") == [
        "21043871", "21059234"]
    # subject works too, and order of appearance is preserved across both
    assert usta_candidates("21059234 Liam Anderson doubles",
                           "partnering 21043871 Ethan Carter") == [
        "21059234", "21043871"]
    # a bare 8-digit run with NO adjacent name does not qualify
    assert extract_ustas("", "ref 20260609 says hello") == []


def test_name_usta_pairs_real_corpus_shapes():
    """(name, USTA#) pair extraction across every shape in the real PDF corpus:
    bullets, parenthesized labels, bare parens, prose, and number-first."""
    from app.email_extract import extract_name_usta_pairs as pairs
    # the TD's reported pattern: bulleted name-then-USTA# lines
    assert pairs("", "* Kate Hampton USTA# 2018840232\n* Cooper Rutledge USTA# 2017193466") == [
        {"name": "Kate Hampton", "usta": "2018840232"},
        {"name": "Cooper Rutledge", "usta": "2017193466"}]
    # parenthesized label / bare parens
    assert pairs("", "Alexandra Dimitrov (USTA 2018522196) and Casey Davis (USTA 2018389707)") == [
        {"name": "Alexandra Dimitrov", "usta": "2018522196"},
        {"name": "Casey Davis", "usta": "2018389707"}]
    assert pairs("", "Kai Hosch (2019209285) and Gabriel Zingman (2019461037) would like to pair") == [
        {"name": "Kai Hosch", "usta": "2019209285"},
        {"name": "Gabriel Zingman", "usta": "2019461037"}]
    # sentence leakage is trimmed ("Macon. Ava Wright" / trailing possessive)
    assert pairs("", "doubles together in Macon. Ava Wright (USTA #2018460819).") == [
        {"name": "Ava Wright", "usta": "2018460819"}]
    # number-first still works
    assert pairs("", "21043871 Ethan Carter with 21059234 Liam Anderson") == [
        {"name": "Ethan Carter", "usta": "21043871"},
        {"name": "Liam Anderson", "usta": "21059234"}]
    # no numbers -> no pairs
    assert pairs("", "Everly and Zaria would love to partner") == []


def test_name_first_eight_digit_unlabeled_qualifies():
    """'Kate Hampton 20188402' — 8 digits, no label, name BEFORE the number:
    the name adjacency admits it as a candidate (a bare 8-digit run without a
    name still doesn't)."""
    from app.email_extract import usta_candidates
    assert usta_candidates("", "Kate Hampton 20188402 wants doubles") == ["20188402"]
    assert usta_candidates("", "ref 20260609 says nothing") == []


def test_extract_names_pulls_both_partners_name_only():
    """A doubles email that only NAMES the two players (no USTA #s) — both spans
    surface, in order, and the glue words ('and', 'with', 'partner') are not
    swallowed into a name."""
    assert extract_names("Doubles request",
                         "Maya Quintero would like to partner with Zara Hollis.") == \
        ["Maya Quintero", "Zara Hollis"]
    assert extract_names("", "Pairing Kate Hampton & Mia Lopez for the weekend") == \
        ["Kate Hampton", "Mia Lopez"]


def test_extract_doubles_pair_name_only_real_shapes():
    """The two players in a name-only doubles request (no USTA #), found by the
    pairing connector — mirrors the real TD corpus."""
    from app.email_extract import extract_doubles_pair as D
    assert D("L3 girls 14U doubles partner",
             "Mia Langone and Chelsea Ie would like to pair up for doubles please.") == \
        ["Mia Langone", "Chelsea Ie"]
    assert D("Ankush Kon - Doubles partner",
             "Please pair Ankush Kotti with Watts Goodman for the B14d L3 closed.") == \
        ["Ankush Kotti", "Watts Goodman"]
    assert D("", "Doubles: Kate Hampton & Mia Lopez") == ["Kate Hampton", "Mia Lopez"]
    assert D("", "pairing Kate Hampton / Mia Lopez") == ["Kate Hampton", "Mia Lopez"]
    # a hyphen sign-off is NOT a pairing connector
    assert D("", "Thanks, Leilei - Mia's mom") == []


def test_name_usta_pairs_permissive_separators_both_directions():
    """The doubles fix: a name and its USTA # bind across whatever 'skip' glue a
    PDF/roster puts between them — double dashes + label, parens, a line break,
    em-dash + colon — in EITHER order, and both players come back in order."""
    from app.email_extract import extract_name_usta_pairs as P, usta_candidates as C
    samples = [
        "Kate Hampton -- USTA#:  2018840232 / Mia Lopez | 2018389707",
        "Doubles: 2018840232 Kate Hampton with 2018389707 Mia Lopez",
        "Player 1: Kate Hampton (2018840232)\nPlayer 2: Mia Lopez (2018389707)",
        "Kate Hampton\n2018840232\nMia Lopez\n2018389707",
    ]
    for t in samples:
        assert P("", t) == [{"name": "Kate Hampton", "usta": "2018840232"},
                            {"name": "Mia Lopez", "usta": "2018389707"}], t
        assert C("", t) == ["2018840232", "2018389707"], t


def test_extract_names_keeps_middle_initial_and_dedupes():
    assert extract_names("", "Maya R. Quintero and Maya R. Quintero again") == \
        ["Maya R Quintero"]
    # a lone capitalized first name (1 token) is not a name span
    assert extract_names("", "just Maya here") == []
