"""Assignments (Tournament <-> Official) with per-day roles + pay/mileage.

Pay     = sum of each worked day's rate (the certification_rate in effect for the
          role worked that day, snapshotted as rate_applied) — audit §3.2.
Mileage = clamp((2 * one_way_miles - 50) * 0.65, 0, 100), using the official's
          distance to the assignment's site — audit §3.1 / §3.7. Null when no
          distance is on file (computation blocked, audit S4).
Hotel date mismatch is surfaced as a flag, not a hard block — audit §3.4.
Room-count IS a hard guard — an official can't be put in a full block (audit §3.4).
Pay/mileage/total are snapshotted on every change with the rule version, so a
figure is reproducible later even if rates/distances change — audit §5.3.
"""
import json

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import AssignmentCreate, AssignmentDayCreate

router = APIRouter(tags=["assignments"])

MILEAGE_RATE = 0.65
FREE_MILES = 50
MILEAGE_CAP = 100.0
RULE_VERSION = "v1: pay=sum(per-day cert rate); mileage=clamp((2*oneway-50)*0.65,0,100)"


def _rate_for(cur, cert_type, work_date) -> float:
    cur.execute(
        """
        SELECT rate_per_day FROM certification_rate
        WHERE cert_type = %s AND effective_from <= %s
        ORDER BY effective_from DESC LIMIT 1
        """,
        (cert_type, work_date),
    )
    row = cur.fetchone()
    if row is None:
        cur.execute(
            "SELECT rate_per_day FROM certification_rate WHERE cert_type = %s "
            "ORDER BY effective_from DESC LIMIT 1",
            (cert_type,),
        )
        row = cur.fetchone()
    return float(row["rate_per_day"]) if row else 0.0


def _summary(cur, a: dict) -> dict:
    """Build a rich assignment object with days + computed pay/mileage/flags."""
    cur.execute(
        "SELECT id, work_date, working_as, rate_applied FROM assignment_day "
        "WHERE assignment_id = %s ORDER BY work_date",
        (a["id"],),
    )
    days = cur.fetchall()
    for d in days:
        d["rate_applied"] = float(d["rate_applied"])
        d["work_date"] = d["work_date"].isoformat()

    # Certification check: a day whose role the official doesn't hold a cert for
    # is flagged (never blocked — the picker filters at assign time, but manual /
    # edit / pre-existing rows can carry an uncertified role). Mirrors the
    # availability / off-window flag policy.
    cur.execute(
        "SELECT cert_type FROM certification WHERE official_id = %s",
        (a["official_id"],),
    )
    held_certs = {r["cert_type"] for r in cur.fetchall()}
    uncertified_days: list[dict] = []
    for d in days:
        bad = d["working_as"] not in held_certs
        d["uncertified"] = bad
        if bad:
            uncertified_days.append({"work_date": d["work_date"], "working_as": d["working_as"]})

    pay = round(sum(d["rate_applied"] for d in days), 2)

    mileage = None
    missing_distance = False
    one_way_miles = None  # the mileage calc input (snapshotted for audit §5.3)
    if a["site_id"] is not None:
        cur.execute(
            "SELECT one_way_miles FROM official_site_distance "
            "WHERE official_id = %s AND site_id = %s",
            (a["official_id"], a["site_id"]),
        )
        dist = cur.fetchone()
        if dist is None:
            missing_distance = True
        else:
            one_way_miles = float(dist["one_way_miles"])
            reimbursable = max(2 * one_way_miles - FREE_MILES, 0.0)
            mileage = round(min(reimbursable * MILEAGE_RATE, MILEAGE_CAP), 2)

    check_in = a["hotel_check_in"].isoformat() if a.get("hotel_check_in") else None
    check_out = a["hotel_check_out"].isoformat() if a.get("hotel_check_out") else None
    hotel_date_mismatch = False
    if a["room_block_id"] is not None and days and check_in and check_out:
        wd = [d["work_date"] for d in days]
        hotel_date_mismatch = any(d < check_in or d > check_out for d in wd)

    # A worked day outside the tournament's play window is surfaced as a flag, not
    # a block (consistent with the hotel-date-mismatch policy, audit §3.4).
    work_date_out_of_window = False
    if days and a.get("play_start_date") and a.get("play_end_date"):
        ps, pe = a["play_start_date"].isoformat(), a["play_end_date"].isoformat()
        work_date_out_of_window = any(d["work_date"] < ps or d["work_date"] > pe for d in days)

    # Double-booking: the same official worked on a date in ANOTHER assignment.
    # (Within one tournament an official has a single assignment with one role
    # per date — UNIQUE(assignment_id, work_date) — so a same-day clash can only
    # be cross-tournament.) Surfaced as a flag, not a block (audit §3.4): the TD
    # may legitimately double-book one venue, but two sites on one day is
    # impossible, so we also note whether the other booking is a different site.
    # Every date this official works in ANOTHER assignment — used both for the
    # conflict flags (dates that overlap THIS assignment's days) and the add-day
    # pre-check (warn before booking a date they already work elsewhere).
    cur.execute(
        "SELECT ad.work_date, a2.tournament_id AS other_tournament_id, "
        "       t2.name AS other_tournament, COALESCE(s2.code, s2.name) AS other_site, "
        "       a2.site_id AS other_site_id "
        "FROM assignment_day ad "
        "JOIN assignment a2 ON a2.id = ad.assignment_id "
        "JOIN tournament t2 ON t2.id = a2.tournament_id "
        "LEFT JOIN site s2 ON s2.id = a2.site_id "
        "WHERE a2.official_id = %s AND a2.id <> %s "
        "ORDER BY ad.work_date",
        (a["official_id"], a["id"]),
    )
    this_dates = {d["work_date"] for d in days}
    official_other_dates: list[dict] = []
    conflicts: list[dict] = []
    for r in cur.fetchall():
        wd = r["work_date"].isoformat()
        info = {
            "work_date": wd,
            "other_tournament_id": r["other_tournament_id"],
            "other_tournament": r["other_tournament"],
            "other_site": r["other_site"],
            # a different site on the same day is physically impossible (hard
            # conflict); same/no site may be a legitimate shared venue (soft).
            "different_site": r["other_site_id"] is not None
            and r["other_site_id"] != a["site_id"],
        }
        official_other_dates.append(info)
        if wd in this_dates:
            conflicts.append(info)
    conflict_dates = {c["work_date"] for c in conflicts}
    for d in days:
        d["conflict"] = d["work_date"] in conflict_dates

    # Availability check (audit §Availability): the TD collects each official's
    # available dates per tournament, but assignment did not enforce them. We
    # surface — never block — any worked day the official did NOT declare
    # available, but ONLY when they declared SOMETHING (absence of data is not a
    # decline). Mirrors the work_date_out_of_window / hotel-date policy.
    cur.execute(
        "SELECT available_date FROM availability "
        "WHERE official_id = %s AND tournament_id = %s",
        (a["official_id"], a["tournament_id"]),
    )
    avail_rows = cur.fetchall()
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
        # Contact info (plaintext for officials) — feeds the "chase pending
        # responders" helper so the TD can email/call non-responders.
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
        # Availability mismatch (audit §Availability — a warning, not a block).
        # has_availability_data=False means the official never declared dates, so
        # days_outside_availability is empty and no warning is shown.
        "has_availability_data": has_availability,
        "days_outside_availability": days_outside_availability,
        # Declared available dates — feeds the add-day pre-check (warn before
        # booking a date the official did not mark available).
        "available_dates": sorted(avail_dates),
        # Roles the official is certified for (feeds the add-day cert pre-check)
        # + the days that carry a role they don't hold.
        "held_certs": sorted(held_certs),
        "uncertified_days": uncertified_days,
        "has_uncertified": bool(uncertified_days),
        # Cross-tournament double-booking (audit §3.4 — a warning, not a block).
        "has_conflict": bool(conflicts),
        "has_hard_conflict": any(c["different_site"] for c in conflicts),
        "conflicts": conflicts,
        # All dates this official works elsewhere — feeds the add-day pre-check.
        "official_other_dates": official_other_dates,
        "total": round(pay + (mileage or 0.0), 2),
        "one_way_miles": one_way_miles,  # mileage input (live)
        "rule_version": a.get("rule_version"),
        "snapshot_at": a["snapshot_at"].isoformat() if a.get("snapshot_at") else None,
        # Frozen money audit (inputs + rule constants) from the last snapshot,
        # so a reimbursement is reproducible even if the distance/rate later
        # changes (audit §5.3). Null until first snapshot.
        "pay_audit": a.get("pay_audit"),
        # Official's accept/decline (self-service); 'pending' until they respond.
        "response_status": a.get("response_status"),
        "responded_at": a["responded_at"].isoformat() if a.get("responded_at") else None,
    }


_ASG_SELECT = """
SELECT a.id, a.tournament_id, a.official_id, a.site_id, a.room_block_id,
       a.snapshot_at, a.rule_version, a.pay_audit,
       a.response_status, a.responded_at,
       o.first_name, o.last_name, o.dietary_restrictions,
       o.email AS official_email, o.phone AS official_phone,
       t.play_start_date, t.play_end_date, t.name AS tournament_name,
       COALESCE(s.code, s.name) AS site_label,
       h.name AS hotel_name, rb.check_in AS hotel_check_in, rb.check_out AS hotel_check_out
FROM assignment a
JOIN official o ON o.id = a.official_id
JOIN tournament t ON t.id = a.tournament_id
LEFT JOIN site s ON s.id = a.site_id
LEFT JOIN room_block rb ON rb.id = a.room_block_id
LEFT JOIN hotel h ON h.id = rb.hotel_id
"""


def _check_room_capacity(cur, room_block_id, exclude_id=None) -> None:
    """Hard guard: refuse to put an official in a block with no rooms left."""
    if room_block_id is None:
        return
    cur.execute("SELECT room_count FROM room_block WHERE id = %s", (room_block_id,))
    rb = cur.fetchone()
    if rb is None:
        raise HTTPException(status_code=400, detail="room_block_id does not exist")
    if exclude_id is None:
        cur.execute(
            "SELECT count(*) AS n FROM assignment WHERE room_block_id = %s",
            (room_block_id,),
        )
    else:
        cur.execute(
            "SELECT count(*) AS n FROM assignment WHERE room_block_id = %s AND id <> %s",
            (room_block_id, exclude_id),
        )
    if cur.fetchone()["n"] >= rb["room_count"]:
        raise HTTPException(
            status_code=409, detail=f"room block is full ({rb['room_count']} rooms)"
        )


def _persist_snapshot(cur, assignment_id: int) -> dict:
    """Recompute and freeze pay/mileage/total + the full calc AUDIT (inputs +
    rule constants) on the assignment, so the reimbursement is reproducible even
    if the distance/rates change later (audit §5.3)."""
    cur.execute(_ASG_SELECT + " WHERE a.id = %s", (assignment_id,))
    s = _summary(cur, cur.fetchone())
    audit = {
        "rule_version": RULE_VERSION,
        "constants": {"free_miles": FREE_MILES, "mileage_rate": MILEAGE_RATE,
                      "mileage_cap": MILEAGE_CAP},
        "one_way_miles": s["one_way_miles"],
        "days": [{"work_date": d["work_date"], "working_as": d["working_as"],
                  "rate_applied": d["rate_applied"]} for d in s["days"]],
        "pay": s["pay"], "mileage": s["mileage"], "total": s["total"],
    }
    cur.execute(
        "UPDATE assignment SET snapshot_pay=%s, snapshot_mileage=%s, "
        "snapshot_total=%s, rule_version=%s, pay_audit=%s::jsonb, snapshot_at=now() "
        "WHERE id=%s RETURNING snapshot_at",
        (s["pay"], s["mileage"], s["total"], RULE_VERSION, json.dumps(audit), assignment_id),
    )
    s["rule_version"] = RULE_VERSION
    s["pay_audit"] = audit
    s["snapshot_at"] = cur.fetchone()["snapshot_at"].isoformat()
    return s


def pay_summary(cur, official_id: int) -> dict:
    """Season pay/mileage summary for an official across ALL their tournaments
    (a per-tournament breakdown + totals). Used by the TD endpoint and the
    official's self-service `/api/me/pay-summary`."""
    cur.execute("SELECT first_name, last_name FROM official WHERE id = %s", (official_id,))
    off = cur.fetchone()
    if off is None:
        raise HTTPException(status_code=404, detail="official not found")
    cur.execute(_ASG_SELECT + " WHERE a.official_id = %s ORDER BY t.play_start_date DESC",
                (official_id,))
    rows = [_summary(cur, a) for a in cur.fetchall()]
    tournaments = [{
        "tournament_id": r["tournament_id"], "tournament_name": r["tournament_name"],
        "pay": r["pay"], "mileage": r["mileage"] or 0.0, "total": r["total"],
        "days": len(r["days"]), "response_status": r["response_status"],
    } for r in rows]
    totals = {
        "pay": round(sum(t["pay"] for t in tournaments), 2),
        "mileage": round(sum(t["mileage"] for t in tournaments), 2),
        "total": round(sum(t["total"] for t in tournaments), 2),
        "assignments": len(tournaments),
        "days": sum(t["days"] for t in tournaments),
    }
    return {"official_id": official_id,
            "official_name": f'{off["last_name"]}, {off["first_name"]}',
            "tournaments": tournaments, "totals": totals}


@router.get("/api/officials/{official_id}/pay-summary")
def official_pay_summary(official_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        return pay_summary(cur, official_id)


@router.get("/api/officials/{official_id}/overview")
def official_overview(official_id: int, conn=Depends(db_dep)):
    """Official 360 — the top-bar search lands here: core identity, the certs they
    hold, and their season assignments + pay/mileage totals (reuses pay_summary)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, first_name, last_name, city, state FROM official WHERE id = %s",
            (official_id,),
        )
        off = cur.fetchone()
        if off is None:
            raise HTTPException(status_code=404, detail="official not found")
        cur.execute(
            "SELECT cert_type::text AS cert_type FROM certification "
            "WHERE official_id = %s ORDER BY cert_type::text",
            (official_id,),
        )
        certs = [r["cert_type"] for r in cur.fetchall()]
        pay = pay_summary(cur, official_id)
    return {"official": off, "certs": certs, "pay": pay}


@router.get("/api/tournaments/{tournament_id}/assignments")
def list_assignments(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name", (tournament_id,))
        rows = cur.fetchall()
        return [_summary(cur, a) for a in rows]


@router.post("/api/tournaments/{tournament_id}/assignments", status_code=201)
def create_assignment(tournament_id: int, body: AssignmentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            _check_room_capacity(cur, body.room_block_id)
            cur.execute(
                """
                INSERT INTO assignment (tournament_id, official_id, site_id, room_block_id)
                VALUES (%s, %s, %s, %s) RETURNING id
                """,
                (tournament_id, body.official_id, body.site_id, body.room_block_id),
            )
            new_id = cur.fetchone()["id"]
            return _persist_snapshot(cur, new_id)
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="official already assigned to this tournament")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id, site_id, or room_block_id invalid")


@router.put("/api/assignments/{assignment_id}")
def update_assignment(assignment_id: int, body: AssignmentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            _check_room_capacity(cur, body.room_block_id, exclude_id=assignment_id)
            cur.execute(
                "UPDATE assignment SET official_id=%s, site_id=%s, room_block_id=%s "
                "WHERE id=%s RETURNING id",
                (body.official_id, body.site_id, body.room_block_id, assignment_id),
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            return _persist_snapshot(cur, assignment_id)
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="official already assigned to this tournament")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id, site_id, or room_block_id invalid")


@router.delete("/api/assignments/{assignment_id}", status_code=204)
def delete_assignment(assignment_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM assignment WHERE id = %s", (assignment_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="assignment not found")
    return Response(status_code=204)


@router.post("/api/assignments/{assignment_id}/days", status_code=201)
def add_day(assignment_id: int, body: AssignmentDayCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT official_id FROM assignment WHERE id = %s", (assignment_id,))
        asg = cur.fetchone()
        if asg is None:
            raise HTTPException(status_code=404, detail="assignment not found")
        # If the official has certifications on file, the worked role must be one
        # of them (audit §3.2). If none are recorded, allow (data may be incomplete).
        cur.execute("SELECT count(*) AS n FROM certification WHERE official_id = %s", (asg["official_id"],))
        if cur.fetchone()["n"] > 0:
            cur.execute(
                "SELECT 1 FROM certification WHERE official_id = %s AND cert_type = %s",
                (asg["official_id"], body.working_as),
            )
            if cur.fetchone() is None:
                raise HTTPException(
                    status_code=409,
                    detail=f"official is not certified as {body.working_as}",
                )
        rate = _rate_for(cur, body.working_as, body.work_date)
        try:
            cur.execute(
                """
                INSERT INTO assignment_day (assignment_id, work_date, working_as, rate_applied)
                VALUES (%s, %s, %s, %s) RETURNING id
                """,
                (assignment_id, body.work_date, body.working_as, rate),
            )
        except psycopg.errors.UniqueViolation:
            raise HTTPException(status_code=409, detail="this work date is already on the assignment")
        return _persist_snapshot(cur, assignment_id)


@router.delete("/api/assignment-days/{day_id}", status_code=204)
def delete_day(day_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT assignment_id FROM assignment_day WHERE id = %s", (day_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="assignment day not found")
        assignment_id = row["assignment_id"]
        cur.execute("DELETE FROM assignment_day WHERE id = %s", (day_id,))
        _persist_snapshot(cur, assignment_id)
    return Response(status_code=204)
