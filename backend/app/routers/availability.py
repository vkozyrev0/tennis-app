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
