"""Assignments (Tournament <-> Official) with per-day roles + pay/mileage.

Pay     = sum of each worked day's rate (the certification_rate in effect for the
          role worked that day, snapshotted as rate_applied) — audit §3.2.
Mileage = clamp((2 * one_way_miles - 50) * 0.65, 0, 100), using the official's
          distance to the assignment's site — audit §3.1 / §3.7. Null when no
          distance is on file (computation blocked, audit S4).
Hotel date mismatch is surfaced as a flag, not a hard block — audit §3.4.
"""
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import AssignmentCreate, AssignmentDayCreate

router = APIRouter(tags=["assignments"])

MILEAGE_RATE = 0.65
FREE_MILES = 50
MILEAGE_CAP = 100.0


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

    return {
        "id": a["id"],
        "tournament_id": a["tournament_id"],
        "official_id": a["official_id"],
        "official_name": f'{a["last_name"]}, {a["first_name"]}',
        "site_id": a["site_id"],
        "site_label": a["site_label"],
        "room_block_id": a["room_block_id"],
        "hotel_name": a["hotel_name"],
        "days": days,
        "pay": pay,
        "mileage": mileage,
        "missing_distance": missing_distance,
        "hotel_date_mismatch": hotel_date_mismatch,
        "total": round(pay + (mileage or 0.0), 2),
    }


_ASG_SELECT = """
SELECT a.id, a.tournament_id, a.official_id, a.site_id, a.room_block_id,
       o.first_name, o.last_name,
       COALESCE(s.code, s.name) AS site_label,
       h.name AS hotel_name
FROM assignment a
JOIN official o ON o.id = a.official_id
LEFT JOIN site s ON s.id = a.site_id
LEFT JOIN room_block rb ON rb.id = a.room_block_id
LEFT JOIN hotel h ON h.id = rb.hotel_id
"""


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
            cur.execute(
                """
                INSERT INTO assignment (tournament_id, official_id, site_id, room_block_id)
                VALUES (%s, %s, %s, %s) RETURNING id
                """,
                (tournament_id, body.official_id, body.site_id, body.room_block_id),
            )
            new_id = cur.fetchone()["id"]
            cur.execute(_ASG_SELECT + " WHERE a.id = %s", (new_id,))
            return _summary(cur, cur.fetchone())
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="official already assigned to this tournament")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id, site_id, or room_block_id invalid")


@router.put("/api/assignments/{assignment_id}")
def update_assignment(assignment_id: int, body: AssignmentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE assignment SET official_id=%s, site_id=%s, room_block_id=%s "
                "WHERE id=%s RETURNING id",
                (body.official_id, body.site_id, body.room_block_id, assignment_id),
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            cur.execute(_ASG_SELECT + " WHERE a.id = %s", (assignment_id,))
            return _summary(cur, cur.fetchone())
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
        cur.execute("SELECT id FROM assignment WHERE id = %s", (assignment_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="assignment not found")
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
        cur.execute(_ASG_SELECT + " WHERE a.id = %s", (assignment_id,))
        return _summary(cur, cur.fetchone())


@router.delete("/api/assignment-days/{day_id}", status_code=204)
def delete_day(day_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM assignment_day WHERE id = %s", (day_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="assignment day not found")
    return Response(status_code=204)
