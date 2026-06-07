"""Official availability per tournament (TD-entered). Phase 2 / audit §Availability."""
import psycopg
from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from ..models import AvailabilitySet

router = APIRouter(tags=["availability"])


@router.get("/api/tournaments/{tournament_id}/availability")
def list_availability(tournament_id: int, conn=Depends(db_dep)):
    """All availability rows for the tournament, with the official's name."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.id, a.official_id, a.available_date, a.hotel_needed,
                   o.first_name, o.last_name
            FROM availability a JOIN official o ON o.id = a.official_id
            WHERE a.tournament_id = %s
            ORDER BY o.last_name, o.first_name, a.available_date
            """,
            (tournament_id,),
        )
        rows = cur.fetchall()
    for r in rows:
        r["available_date"] = r["available_date"].isoformat()
        r["official_name"] = f'{r.pop("last_name")}, {r.pop("first_name")}'
    return rows


@router.get("/api/tournaments/{tournament_id}/availability/grid")
def availability_grid(tournament_id: int, conn=Depends(db_dep)):
    """Availability heatmap matrix: the play-window days, one row per official who
    either declared availability OR is assigned, and per-day totals. Each official
    row carries the dates they're `available` and the dates they're `assigned`
    (actually working), so the TD sees offered-vs-staffed at a glance and which
    days are thin. Built from availability + assignment_day (no new tables)."""
    from datetime import timedelta
    with conn.cursor() as cur:
        cur.execute(
            "SELECT play_start_date, play_end_date FROM tournament WHERE id = %s",
            (tournament_id,),
        )
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        start, end = t["play_start_date"], t["play_end_date"]
        days = []
        if start and end and start <= end:
            d = start
            while d <= end:
                days.append(d.isoformat())
                d += timedelta(days=1)

        cur.execute(
            "SELECT a.official_id, a.available_date, a.hotel_needed, "
            "       o.first_name, o.last_name "
            "FROM availability a JOIN official o ON o.id = a.official_id "
            "WHERE a.tournament_id = %s",
            (tournament_id,),
        )
        avail_rows = cur.fetchall()

        cur.execute(
            "SELECT a.official_id, ad.work_date, o.first_name, o.last_name "
            "FROM assignment a "
            "JOIN assignment_day ad ON ad.assignment_id = a.id "
            "JOIN official o ON o.id = a.official_id "
            "WHERE a.tournament_id = %s",
            (tournament_id,),
        )
        asg_rows = cur.fetchall()

    officials: dict = {}

    def _row(oid, first, last):
        return officials.setdefault(oid, {
            "official_id": oid,
            "official_name": f"{last}, {first}",
            "hotel_needed": False, "available": set(), "assigned": set(),
        })

    for r in avail_rows:
        row = _row(r["official_id"], r["first_name"], r["last_name"])
        row["available"].add(r["available_date"].isoformat())
        if r["hotel_needed"]:
            row["hotel_needed"] = True
    for r in asg_rows:
        row = _row(r["official_id"], r["first_name"], r["last_name"])
        row["assigned"].add(r["work_date"].isoformat())

    out_officials = [
        {**o, "available": sorted(o["available"]), "assigned": sorted(o["assigned"])}
        for o in sorted(officials.values(), key=lambda o: o["official_name"])
    ]
    per_day = [
        {"date": d,
         "available_count": sum(1 for o in out_officials if d in o["available"]),
         "assigned_count": sum(1 for o in out_officials if d in o["assigned"])}
        for d in days
    ]
    return {"days": days, "officials": out_officials, "per_day": per_day}


@router.put("/api/tournaments/{tournament_id}/availability")
def set_availability(tournament_id: int, body: AvailabilitySet, conn=Depends(db_dep)):
    """Replace one official's available dates for this tournament."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute("SELECT id FROM official WHERE id = %s", (body.official_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=400, detail="official_id does not exist")
        cur.execute(
            "DELETE FROM availability WHERE tournament_id = %s AND official_id = %s",
            (tournament_id, body.official_id),
        )
        try:
            for d in body.dates:
                cur.execute(
                    "INSERT INTO availability (official_id, tournament_id, available_date, hotel_needed) "
                    "VALUES (%s, %s, %s, %s)",
                    (body.official_id, tournament_id, d, body.hotel_needed),
                )
        except psycopg.errors.ForeignKeyViolation:
            raise HTTPException(status_code=400, detail="invalid official_id or tournament_id")
    return {"official_id": body.official_id, "dates": [d.isoformat() for d in body.dates],
            "hotel_needed": body.hotel_needed}
