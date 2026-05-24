"""Tournament <-> Player roster (tournament_entry)."""
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import RosterEntryCreate, RosterEntryOut

router = APIRouter(tags=["roster"])

_SELECT = """
SELECT e.id, e.tournament_id, e.player_id, e.age_division, e.events,
       e.selection_status, e.t_shirt_size, e.dietary_preference,
       p.usta_number, p.first_name, p.last_name
FROM tournament_entry e JOIN player p ON p.id = e.player_id
"""


@router.get("/api/tournaments/{tournament_id}/players", response_model=list[RosterEntryOut])
def list_roster(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_SELECT + " WHERE e.tournament_id = %s ORDER BY p.last_name, p.first_name",
                    (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/players",
             response_model=RosterEntryOut, status_code=201)
def add_roster_entry(tournament_id: int, body: RosterEntryCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO tournament_entry
                    (tournament_id, player_id, age_division, events,
                     selection_status, t_shirt_size, dietary_preference)
                VALUES (%(tournament_id)s, %(player_id)s, %(age_division)s, %(events)s,
                        %(selection_status)s, %(t_shirt_size)s, %(dietary_preference)s)
                RETURNING id
                """,
                {**body.model_dump(), "tournament_id": tournament_id},
            )
            new_id = cur.fetchone()["id"]
            cur.execute(_SELECT + " WHERE e.id = %s", (new_id,))
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="player already on this tournament roster")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="tournament_id or player_id does not exist")


@router.put("/api/roster/{entry_id}", response_model=RosterEntryOut)
def update_roster_entry(entry_id: int, body: RosterEntryCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE tournament_entry SET
                    player_id = %(player_id)s, age_division = %(age_division)s,
                    events = %(events)s, selection_status = %(selection_status)s,
                    t_shirt_size = %(t_shirt_size)s, dietary_preference = %(dietary_preference)s
                WHERE id = %(id)s
                RETURNING id
                """,
                {**body.model_dump(), "id": entry_id},
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="roster entry not found")
            cur.execute(_SELECT + " WHERE e.id = %s", (entry_id,))
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="player already on this tournament roster")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="player_id does not exist")


@router.delete("/api/roster/{entry_id}", status_code=204)
def delete_roster_entry(entry_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM tournament_entry WHERE id = %s", (entry_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="roster entry not found")
    return Response(status_code=204)
