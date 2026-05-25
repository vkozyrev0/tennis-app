"""Player-reported hotel stays + CVB room-night analytics (audit §1.2).
Also the cumulative cross-tournament t-shirt list (derived from tournament_entry)."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import PlayerHotelCreate, PlayerHotelOut, TShirtRow
from ..playerops import mark_email_filed, upsert_player

router = APIRouter(tags=["player-ops"])

_PH = """
SELECT s.id, s.tournament_id, s.player_id, s.hotel_name, s.source_email_id,
       p.usta_number, p.first_name, p.last_name
FROM player_hotel_stay s JOIN player p ON p.id = s.player_id
"""


@router.get("/api/tournaments/{tournament_id}/player-hotels", response_model=list[PlayerHotelOut])
def list_player_hotels(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_PH + " WHERE s.tournament_id = %s ORDER BY s.id", (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/player-hotels",
             response_model=PlayerHotelOut, status_code=201)
def create_player_hotel(tournament_id: int, body: PlayerHotelCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name)
        cur.execute(
            "INSERT INTO player_hotel_stay (tournament_id, player_id, hotel_name, source_email_id) "
            "VALUES (%s,%s,%s,%s) RETURNING id",
            (tournament_id, pid, body.hotel_name, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]
        mark_email_filed(cur, body.source_email_id, "hotel")
        cur.execute(_PH + " WHERE s.id = %s", (new_id,))
        return cur.fetchone()


@router.delete("/api/player-hotels/{row_id}", status_code=204)
def delete_player_hotel(row_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM player_hotel_stay WHERE id = %s", (row_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


@router.get("/api/hotel-analytics")
def hotel_analytics(conn=Depends(db_dep)):
    """Room-night patterns across all tournaments (for CVB negotiations)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT COALESCE(NULLIF(TRIM(hotel_name), ''), '(unspecified)') AS hotel_name,
                   count(*) AS stays
            FROM player_hotel_stay
            GROUP BY 1 ORDER BY stays DESC, hotel_name
            """
        )
        return cur.fetchall()


@router.get("/api/tshirts", response_model=list[TShirtRow])
def tshirts(conn=Depends(db_dep)):
    """Cumulative cross-tournament t-shirt list (audit §8 F1) — derived from the
    roster, so a player's most recent size is known even for late entrants."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.player_id, p.usta_number, p.first_name, p.last_name,
                   e.age_division, e.tournament_id, t.name AS tournament_name, e.t_shirt_size
            FROM tournament_entry e
            JOIN player p ON p.id = e.player_id
            JOIN tournament t ON t.id = e.tournament_id
            WHERE e.t_shirt_size IS NOT NULL AND e.t_shirt_size <> ''
            ORDER BY p.last_name, p.first_name, t.play_start_date DESC
            """
        )
        return cur.fetchall()
