"""UNIT tests for the pure email-text extractors (app/email_extract.py,
plan P2 #9) — no DB, no HTTP. The withdrawal-reason patterns also have
corpus-style coverage in test_zz_inbox.py; these pin each extractor's contract
directly (incl. the conservative give-up paths)."""
from app.email_extract import (
    extract_age_division,
    extract_avoid_day,
    extract_avoid_time,
    extract_events,
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
