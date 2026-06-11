"""Assignment pay / mileage / flag calculation — PURE functions, no DB.

Extracted from routers/assignments.py (improvement-plan P2 #8) so the money
path — the single source of truth for pay, mileage, conflicts, availability,
certification and date-window flags — is unit-testable directly instead of
only through API integration tests. The router fetches the rows; this module
computes. Behaviour is move-only: identical to the in-router version.

Domain rules (audit refs in routers/assignments.py):
- pay     = Σ rate_applied over worked days (per-day cert rate, snapshotted)
- mileage = clamp((2·one_way − FREE_MILES) · MILEAGE_RATE, 0, MILEAGE_CAP),
            None when no distance is on file (computation blocked)
- conflicts / availability / certification / date windows are FLAGS, not blocks
"""

MILEAGE_RATE = 0.65
FREE_MILES = 50
MILEAGE_CAP = 100.0
RULE_VERSION = "v1: pay=sum(per-day cert rate); mileage=clamp((2*oneway-50)*0.65,0,100)"


def mileage_for(one_way_miles: float | None) -> float | None:
    """The mileage formula. None in (no distance on file) → None out.
    First FREE_MILES round-trip miles are free, so one-way ≤ 25 yields 0.0."""
    if one_way_miles is None:
        return None
    reimbursable = max(2 * one_way_miles - FREE_MILES, 0.0)
    return round(min(reimbursable * MILEAGE_RATE, MILEAGE_CAP), 2)


def pay_for(days: list[dict]) -> float:
    """Σ rate_applied over the days — EXCLUDING no_show days (P4-1 day-of
    truth: an official who didn't show isn't paid for that day). Days without
    an actual_status count (planned/worked/early_departure all pay)."""
    return round(sum(d["rate_applied"] for d in days
                     if d.get("actual_status") != "no_show"), 2)


def compute_summary(a: dict, days: list[dict], held_certs: set[str],
                    one_way_miles: float | None, missing_distance: bool,
                    other_bookings: list[dict], avail_rows: list[dict]) -> dict:
    """Assemble the rich assignment object from pre-fetched rows.

    `a`              — the assignment row (joined with official/site/hotel/
                       tournament fields; raw date/datetime objects).
    `days`           — assignment_day rows (id, work_date as date,
                       rate_applied as Decimal/float).
    `held_certs`     — cert_type values the official holds.
    `one_way_miles` / `missing_distance` — distance lookup result for the
                       assignment's site (both falsy when site_id is None).
    `other_bookings` — this official's days in OTHER assignments (work_date as
                       date, other_tournament_id/-name, other_site,
                       other_site_id).
    `avail_rows`     — availability rows for this official+tournament
                       (available_date as date); empty list = never declared.
    """
    days = [dict(d) for d in days]
    for d in days:
        d["rate_applied"] = float(d["rate_applied"])
        d["work_date"] = d["work_date"].isoformat()

    # Certification check: a day whose role the official doesn't hold a cert for
    # is flagged (never blocked — the picker filters at assign time, but manual /
    # edit / pre-existing rows can carry an uncertified role).
    uncertified_days: list[dict] = []
    for d in days:
        bad = d["working_as"] not in held_certs
        d["uncertified"] = bad
        if bad:
            uncertified_days.append({"work_date": d["work_date"], "working_as": d["working_as"]})

    pay = pay_for(days)
    mileage = mileage_for(one_way_miles)

    check_in = a["hotel_check_in"].isoformat() if a.get("hotel_check_in") else None
    check_out = a["hotel_check_out"].isoformat() if a.get("hotel_check_out") else None
    hotel_date_mismatch = False
    if a["room_block_id"] is not None and days and check_in and check_out:
        wd = [d["work_date"] for d in days]
        hotel_date_mismatch = any(d < check_in or d > check_out for d in wd)

    # A worked day outside the tournament's play window is surfaced as a flag,
    # not a block (consistent with the hotel-date-mismatch policy).
    work_date_out_of_window = False
    if days and a.get("play_start_date") and a.get("play_end_date"):
        ps, pe = a["play_start_date"].isoformat(), a["play_end_date"].isoformat()
        work_date_out_of_window = any(d["work_date"] < ps or d["work_date"] > pe for d in days)

    # Double-booking: the same official worked on a date in ANOTHER assignment.
    # A different site on the same day is physically impossible (hard conflict);
    # same/no site may be a legitimate shared venue (soft).
    this_dates = {d["work_date"] for d in days}
    official_other_dates: list[dict] = []
    conflicts: list[dict] = []
    for r in other_bookings:
        wd = r["work_date"].isoformat()
        info = {
            "work_date": wd,
            "other_tournament_id": r["other_tournament_id"],
            "other_tournament": r["other_tournament"],
            "other_site": r["other_site"],
            "different_site": r["other_site_id"] is not None
            and r["other_site_id"] != a["site_id"],
        }
        official_other_dates.append(info)
        if wd in this_dates:
            conflicts.append(info)
    conflict_dates = {c["work_date"] for c in conflicts}
    for d in days:
        d["conflict"] = d["work_date"] in conflict_dates

    # Availability: surface — never block — any worked day the official did NOT
    # declare available, but ONLY when they declared SOMETHING (absence of data
    # is not a decline).
    has_availability = bool(avail_rows)
    avail_dates = {r["available_date"].isoformat() for r in avail_rows}
    days_outside_availability: list[str] = []
    if has_availability:
        days_outside_availability = [
            d["work_date"] for d in days if d["work_date"] not in avail_dates
        ]
    for d in days:
        d["outside_availability"] = (
            has_availability and d["work_date"] not in avail_dates
        )

    return {
        "id": a["id"],
        "tournament_id": a["tournament_id"],
        "tournament_name": a.get("tournament_name"),
        "official_id": a["official_id"],
        "official_name": f'{a["last_name"]}, {a["first_name"]}',
        "official_email": a.get("official_email"),
        "official_phone": a.get("official_phone"),
        "dietary_restrictions": a.get("dietary_restrictions"),
        "site_id": a["site_id"],
        "site_label": a["site_label"],
        "room_block_id": a["room_block_id"],
        "hotel_name": a["hotel_name"],
        "check_in": check_in,
        "check_out": check_out,
        "days": days,
        "pay": pay,
        "mileage": mileage,
        "missing_distance": missing_distance,
        "hotel_date_mismatch": hotel_date_mismatch,
        "work_date_out_of_window": work_date_out_of_window,
        "has_availability_data": has_availability,
        "days_outside_availability": days_outside_availability,
        "available_dates": sorted(avail_dates),
        "held_certs": sorted(held_certs),
        "uncertified_days": uncertified_days,
        "has_uncertified": bool(uncertified_days),
        "has_conflict": bool(conflicts),
        "has_hard_conflict": any(c["different_site"] for c in conflicts),
        "conflicts": conflicts,
        # Day-of truth rollup (P4-1): how many days didn't happen as planned.
        "no_show_days": sum(1 for d in days if d.get("actual_status") == "no_show"),
        "official_other_dates": official_other_dates,
        "total": round(pay + (mileage or 0.0), 2),
        "one_way_miles": one_way_miles,
        "rule_version": a.get("rule_version"),
        "snapshot_at": a["snapshot_at"].isoformat() if a.get("snapshot_at") else None,
        "pay_audit": a.get("pay_audit"),
        "response_status": a.get("response_status"),
        "responded_at": a["responded_at"].isoformat() if a.get("responded_at") else None,
    }
