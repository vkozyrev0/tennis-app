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

    pay = round(sum(d["rate_applied"] for d in days), 2)

    mileage = None
    missing_distance = False
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
            reimbursable = max(2 * float(dist["one_way_miles"]) - FREE_MILES, 0.0)
            mileage = round(min(reimbursable * MILEAGE_RATE, MILEAGE_CAP), 2)

    hotel_date_mismatch = False
    if a["room_block_id"] is not None and days:
        cur.execute(
            "SELECT check_in, check_out FROM room_block WHERE id = %s",
            (a["room_block_id"],),
        )
        blk = cur.fetchone()
        if blk and blk["check_in"] and blk["check_out"]:
            wd = [d["work_date"] for d in days]
            ci, co = blk["check_in"].isoformat(), blk["check_out"].isoformat()
            hotel_date_mismatch = any(d < ci or d > co for d in wd)

    # A worked day outside the tournament's play window is surfaced as a flag, not
    # a block (consistent with the hotel-date-mismatch policy, audit §3.4).
    work_date_out_of_window = False
    if days and a.get("play_start_date") and a.get("play_end_date"):
        ps, pe = a["play_start_date"].isoformat(), a["play_end_date"].isoformat()
        work_date_out_of_window = any(d["work_date"] < ps or d["work_date"] > pe for d in days)

    return {
        "id": a["id"],
        "tournament_id": a["tournament_id"],
        "official_id": a["official_id"],
        "official_name": f'{a["last_name"]}, {a["first_name"]}',
        "dietary_restrictions": a.get("dietary_restrictions"),
        "site_id": a["site_id"],
        "site_label": a["site_label"],
        "room_block_id": a["room_block_id"],
        "hotel_name": a["hotel_name"],
        "days": days,
        "pay": pay,
        "mileage": mileage,
        "missing_distance": missing_distance,
        "hotel_date_mismatch": hotel_date_mismatch,
        "work_date_out_of_window": work_date_out_of_window,
        "total": round(pay + (mileage or 0.0), 2),
        "rule_version": a.get("rule_version"),
        "snapshot_at": a["snapshot_at"].isoformat() if a.get("snapshot_at") else None,
    }


_ASG_SELECT = """
SELECT a.id, a.tournament_id, a.official_id, a.site_id, a.room_block_id,
       a.snapshot_at, a.rule_version,
       o.first_name, o.last_name, o.dietary_restrictions,
       t.play_start_date, t.play_end_date,
       COALESCE(s.code, s.name) AS site_label,
       h.name AS hotel_name
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
    """Recompute and freeze pay/mileage/total + rule version on the assignment."""
    cur.execute(_ASG_SELECT + " WHERE a.id = %s", (assignment_id,))
    s = _summary(cur, cur.fetchone())
    cur.execute(
        "UPDATE assignment SET snapshot_pay=%s, snapshot_mileage=%s, "
        "snapshot_total=%s, rule_version=%s, snapshot_at=now() WHERE id=%s "
        "RETURNING snapshot_at",
        (s["pay"], s["mileage"], s["total"], RULE_VERSION, assignment_id),
    )
    s["rule_version"] = RULE_VERSION
    s["snapshot_at"] = cur.fetchone()["snapshot_at"].isoformat()
    return s


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
