"""Player-reported hotel stays + CVB room-night analytics (audit §1.2).
Also the cumulative cross-tournament t-shirt list (derived from tournament_entry)."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import PlayerHotelCreate, PlayerHotelOut, PlayerHotelUpdate, TShirtRow
from ..playerops import mark_email_filed, upsert_hotel, upsert_player

router = APIRouter(tags=["player-ops"])

_PH = """
SELECT s.id, s.tournament_id, s.player_id, s.hotel_id, s.hotel_name, s.lodging_plan,
       s.source_email_id, p.usta_number, p.first_name, p.last_name,
       te.age_division
FROM player_hotel_stay s
JOIN player p ON p.id = s.player_id
LEFT JOIN tournament_entry te
       ON te.tournament_id = s.tournament_id AND te.player_id = s.player_id
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
        # One canonical hotel row per name (case-insensitive) — FK keeps names consistent.
        hid, hname = upsert_hotel(cur, body.hotel_name)
        lodging = " ".join((body.lodging_plan or "").split()) or None
        cur.execute(
            "INSERT INTO player_hotel_stay (tournament_id, player_id, hotel_id, hotel_name, lodging_plan, source_email_id) "
            "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
            (tournament_id, pid, hid, hname, lodging, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]
        mark_email_filed(cur, body.source_email_id, "hotel")
        cur.execute(_PH + " WHERE s.id = %s", (new_id,))
        return cur.fetchone()


@router.put("/api/player-hotels/{row_id}", response_model=PlayerHotelOut)
def update_player_hotel(row_id: int, body: PlayerHotelUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM player_hotel_stay WHERE id = %s", (row_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="not found")
        # Keep the hotel name canonical/consistent via the Hotels table (FK).
        hid, hname = upsert_hotel(cur, body.hotel_name)
        lodging = " ".join((body.lodging_plan or "").split()) or None
        cur.execute(
            "UPDATE player_hotel_stay SET hotel_id = %s, hotel_name = %s, lodging_plan = %s WHERE id = %s",
            (hid, hname, lodging, row_id),
        )
        cur.execute(_PH + " WHERE s.id = %s", (row_id,))
        return cur.fetchone()


@router.delete("/api/player-hotels/{row_id}", status_code=204)
def delete_player_hotel(row_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM player_hotel_stay WHERE id = %s", (row_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


# Count distinct players per hotel. Names are grouped case-insensitively (after
# trimming) for consistency and a representative spelling is shown; blanks are
# excluded; only players who are *in* the tournament (selection_status='selected')
# count — no withdrawals or alternates. Ordered alphabetically.
_HOTEL_SUMMARY = """
SELECT min(TRIM(s.hotel_name)) AS hotel_name, count(DISTINCT s.player_id) AS players
FROM player_hotel_stay s
JOIN tournament_entry e
  ON e.tournament_id = s.tournament_id AND e.player_id = s.player_id
WHERE e.selection_status = 'selected'
  AND NULLIF(TRIM(s.hotel_name), '') IS NOT NULL
  {extra}
GROUP BY lower(TRIM(s.hotel_name))
ORDER BY lower(TRIM(s.hotel_name))
"""


@router.get("/api/tournaments/{tournament_id}/hotel-summary")
def hotel_summary(tournament_id: int, conn=Depends(db_dep)):
    """Per-tournament: players per hotel (selected only, alphabetical, consistent)."""
    with conn.cursor() as cur:
        cur.execute(_HOTEL_SUMMARY.format(extra="AND s.tournament_id = %s"), (tournament_id,))
        return cur.fetchall()


@router.get("/api/tournaments/{tournament_id}/lodging-summary")
def lodging_summary(tournament_id: int, conn=Depends(db_dep)):
    """Per-tournament: players per lodging plan (Hotel/Commuter/…), selected only."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT min(TRIM(s.lodging_plan)) AS lodging_plan,
                   count(DISTINCT s.player_id) AS players
            FROM player_hotel_stay s
            JOIN tournament_entry e
              ON e.tournament_id = s.tournament_id AND e.player_id = s.player_id
            WHERE s.tournament_id = %s AND e.selection_status = 'selected'
              AND NULLIF(TRIM(s.lodging_plan), '') IS NOT NULL
            GROUP BY lower(TRIM(s.lodging_plan))
            ORDER BY lower(TRIM(s.lodging_plan))
            """,
            (tournament_id,),
        )
        return cur.fetchall()


@router.get("/api/tournaments/{tournament_id}/hotel-confidential-report")
def hotel_confidential_report(tournament_id: int, conn=Depends(db_dep)):
    """Confidential per-hotel roster for the tournament: a summary pivot (hotel
    → players + officials counts), then a detail list of each person as
    "F. Last" (first initial + last name) per the TD's privacy requirement.
    Only selected players (no withdrawals/alternates); officials are pulled
    from their hotel assignment (assignment.room_block → hotel)."""
    with conn.cursor() as cur:
        # Selected players, grouped under their hotel (case-insensitive name).
        cur.execute(
            """
            SELECT TRIM(s.hotel_name) AS hotel_name, p.first_name, p.last_name
            FROM player_hotel_stay s
            JOIN player p ON p.id = s.player_id
            JOIN tournament_entry e
              ON e.tournament_id = s.tournament_id AND e.player_id = s.player_id
            WHERE s.tournament_id = %s
              AND e.selection_status = 'selected'
              AND NULLIF(TRIM(s.hotel_name), '') IS NOT NULL
            ORDER BY lower(TRIM(s.hotel_name)), p.last_name, p.first_name
            """,
            (tournament_id,),
        )
        players = cur.fetchall()
        # Officials whose hotel assignment points at a room_block in a hotel.
        cur.execute(
            """
            SELECT h.name AS hotel_name, o.first_name, o.last_name
            FROM assignment a
            JOIN room_block rb ON rb.id = a.room_block_id
            JOIN hotel h ON h.id = rb.hotel_id
            JOIN official o ON o.id = a.official_id
            WHERE a.tournament_id = %s
            ORDER BY h.name, o.last_name, o.first_name
            """,
            (tournament_id,),
        )
        officials = cur.fetchall()

        def initial_of(s):
            return (s[0] + ". ") if s else ""
        def fmt(row):
            return {"hotel_name": row["hotel_name"],
                    "name": initial_of(row["first_name"]) + (row["last_name"] or "—")}

        # Build the pivot.
        summary = {}
        for p in players:
            key = (p["hotel_name"] or "").strip()
            summary.setdefault(key, {"players": 0, "officials": 0})["players"] += 1
        for o in officials:
            key = (o["hotel_name"] or "").strip()
            summary.setdefault(key, {"players": 0, "officials": 0})["officials"] += 1
        summary_rows = sorted(
            [{"hotel_name": k, "players": v["players"], "officials": v["officials"],
              "total": v["players"] + v["officials"]} for k, v in summary.items()],
            key=lambda x: x["hotel_name"].lower(),
        )

        return {
            "tournament_id": tournament_id,
            "summary": summary_rows,
            "players": [fmt(p) for p in players],
            "officials": [fmt(o) for o in officials],
            "totals": {
                "players": len(players),
                "officials": len(officials),
                "total": len(players) + len(officials),
                "hotels": len(summary_rows),
            },
        }


@router.get("/api/hotel-analytics")
def hotel_analytics(conn=Depends(db_dep)):
    """Players per hotel across all tournaments (for CVB negotiations) — selected
    players only, names consistent + alphabetical."""
    with conn.cursor() as cur:
        cur.execute(_HOTEL_SUMMARY.format(extra="").replace("AS players", "AS stays"))
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
              AND e.selection_status = 'selected'  -- no withdrawals/alternates
            ORDER BY p.last_name, p.first_name, t.play_start_date DESC
            """
        )
        return cur.fetchall()
