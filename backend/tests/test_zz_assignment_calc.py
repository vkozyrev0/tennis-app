"""UNIT tests for the pure money/flag calculation (app/assignment_calc.py,
plan P2 #8) — no DB, no HTTP. The API-level behaviour is still covered by
test_zz_money_audit.py / test_zz_conflicts.py / test_td_e2e.py; these pin the
formula and flag semantics directly so a regression points at the exact rule."""
from datetime import date

from app.assignment_calc import (
    FREE_MILES,
    MILEAGE_CAP,
    MILEAGE_RATE,
    compute_summary,
    mileage_for,
    pay_for,
)


# ---------------------------------------------------------------- mileage ----
def test_mileage_none_when_no_distance():
    assert mileage_for(None) is None


def test_mileage_free_band():
    # First FREE_MILES round-trip miles are free: one-way <= 25 -> $0.
    assert mileage_for(0) == 0.0
    assert mileage_for(25) == 0.0          # 2*25-50 = 0 exactly
    assert mileage_for(10) == 0.0


def test_mileage_formula_midrange():
    # 60 one-way: (120-50)*0.65 = 45.5
    assert mileage_for(60) == 45.5
    # just past the free band
    assert mileage_for(26) == round((2 * 26 - FREE_MILES) * MILEAGE_RATE, 2)


def test_mileage_cap_is_hard_ceiling():
    # (2*200-50)*0.65 = 227.5 -> capped at 100
    assert mileage_for(200) == MILEAGE_CAP
    # cap boundary: (2*ow-50)*0.65 == 100 at ow ~ 101.923
    assert mileage_for(101.9) < MILEAGE_CAP
    assert mileage_for(102.0) == MILEAGE_CAP


# -------------------------------------------------------------------- pay ----
def test_pay_sums_per_day_rates():
    days = [{"rate_applied": 250.0}, {"rate_applied": 175.5}, {"rate_applied": 0}]
    assert pay_for(days) == 425.5
    assert pay_for([]) == 0.0


# --------------------------------------------------------- compute_summary ----
def _asg(**over):
    """A minimal assignment row as the router's _ASG_SELECT produces it."""
    base = {
        "id": 1, "tournament_id": 10, "tournament_name": "Test Open",
        "official_id": 5, "first_name": "James", "last_name": "Whitfield",
        "official_email": "j@example.com", "official_phone": None,
        "dietary_restrictions": None,
        "site_id": 3, "site_label": "JDS", "room_block_id": None,
        "hotel_name": None, "hotel_check_in": None, "hotel_check_out": None,
        "play_start_date": date(2026, 7, 10), "play_end_date": date(2026, 7, 12),
        "rule_version": None, "snapshot_at": None, "pay_audit": None,
        "response_status": "pending", "responded_at": None,
    }
    base.update(over)
    return base


def _day(d, role="roving_official", rate=250.0):
    return {"id": 99, "work_date": d, "working_as": role, "rate_applied": rate}


def _calc(a=None, days=(), held=("roving_official",), one_way=60.0,
          missing=False, others=(), avail=()):
    return compute_summary(a or _asg(), list(days), set(held), one_way, missing,
                           list(others), list(avail))


def test_summary_money_and_total():
    s = _calc(days=[_day(date(2026, 7, 10)), _day(date(2026, 7, 11), rate=175.0)])
    assert s["pay"] == 425.0
    assert s["mileage"] == 45.5            # 60 one-way
    assert s["total"] == 470.5
    assert s["one_way_miles"] == 60.0
    assert s["missing_distance"] is False


def test_summary_total_with_missing_distance():
    s = _calc(days=[_day(date(2026, 7, 10))], one_way=None, missing=True)
    assert s["mileage"] is None
    assert s["missing_distance"] is True
    assert s["total"] == s["pay"]          # mileage None contributes 0


def test_uncertified_days_flagged_not_blocked():
    s = _calc(days=[_day(date(2026, 7, 10), role="chair_umpire")],
              held=("roving_official",))
    assert s["has_uncertified"] is True
    assert s["days"][0]["uncertified"] is True
    assert s["uncertified_days"] == [
        {"work_date": "2026-07-10", "working_as": "chair_umpire"}]


def test_conflict_same_day_other_assignment():
    others = [{"work_date": date(2026, 7, 10), "other_tournament_id": 11,
               "other_tournament": "Other Open", "other_site": "ROME",
               "other_site_id": 7}]
    s = _calc(days=[_day(date(2026, 7, 10)), _day(date(2026, 7, 11))], others=others)
    assert s["has_conflict"] is True
    assert s["has_hard_conflict"] is True          # different site -> physically impossible
    assert s["days"][0]["conflict"] is True
    assert s["days"][1]["conflict"] is False
    assert len(s["official_other_dates"]) == 1     # feeds the add-day pre-check


def test_conflict_same_site_is_soft():
    others = [{"work_date": date(2026, 7, 10), "other_tournament_id": 11,
               "other_tournament": "Other Open", "other_site": "JDS",
               "other_site_id": 3}]                # same site_id as the assignment
    s = _calc(days=[_day(date(2026, 7, 10))], others=others)
    assert s["has_conflict"] is True
    assert s["has_hard_conflict"] is False


def test_availability_absence_of_data_is_not_a_decline():
    s = _calc(days=[_day(date(2026, 7, 10))], avail=[])
    assert s["has_availability_data"] is False
    assert s["days_outside_availability"] == []
    assert s["days"][0]["outside_availability"] is False


def test_availability_declared_dates_flag_others():
    avail = [{"available_date": date(2026, 7, 11)}]
    s = _calc(days=[_day(date(2026, 7, 10)), _day(date(2026, 7, 11))], avail=avail)
    assert s["has_availability_data"] is True
    assert s["days_outside_availability"] == ["2026-07-10"]
    assert s["days"][0]["outside_availability"] is True
    assert s["days"][1]["outside_availability"] is False


def test_hotel_date_mismatch_flag():
    a = _asg(room_block_id=4, hotel_name="Inn",
             hotel_check_in=date(2026, 7, 10), hotel_check_out=date(2026, 7, 11))
    s = _calc(a=a, days=[_day(date(2026, 7, 12))])     # works after check-out
    assert s["hotel_date_mismatch"] is True
    s2 = _calc(a=a, days=[_day(date(2026, 7, 10))])
    assert s2["hotel_date_mismatch"] is False


def test_work_date_out_of_window_flag():
    s = _calc(days=[_day(date(2026, 7, 9))])           # before play_start 7/10
    assert s["work_date_out_of_window"] is True
    s2 = _calc(days=[_day(date(2026, 7, 10))])
    assert s2["work_date_out_of_window"] is False


def test_summary_shape_and_name():
    s = _calc(days=[_day(date(2026, 7, 10))])
    assert s["official_name"] == "Whitfield, James"
    for key in ("pay", "mileage", "total", "days", "conflicts", "held_certs",
                "available_dates", "response_status", "snapshot_at", "pay_audit"):
        assert key in s
