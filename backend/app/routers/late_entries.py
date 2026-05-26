"""Late entries (Part B, first list). Filing one upserts the player + their
tournament_entry (source=late_entry) and marks the source email filed (audit §4.1)."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import LateEntryCreate, LateEntryOut, LateEntryUpdate

router = APIRouter(tags=["late-entries"])

_SELECT = """
SELECT le.id, le.tournament_id, le.player_id, le.request_date, le.request_time,
       le.age_division, le.events, le.source_email_id,
       p.usta_number, p.first_name, p.last_name,
       (t.late_entry_deadline IS NOT NULL
        AND COALESCE(le.request_date, CURRENT_DATE) > t.late_entry_deadline) AS past_deadline
FROM late_entry le
JOIN player p ON p.id = le.player_id
JOIN tournament t ON t.id = le.tournament_id
"""


@router.get("/api/tournaments/{tournament_id}/late-entries", response_model=list[LateEntryOut])
def list_late_entries(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_SELECT + " WHERE le.tournament_id = %s ORDER BY le.request_date, le.id",
                    (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/late-entries",
             response_model=LateEntryOut, status_code=201)
def create_late_entry(tournament_id: int, body: LateEntryCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")

        # Upsert the player by USTA number.
        cur.execute("SELECT id FROM player WHERE usta_number = %s", (body.usta_number,))
        p = cur.fetchone()
        if p:
            pid = p["id"]
            if body.first_name or body.last_name:
                cur.execute(
                    "UPDATE player SET first_name = COALESCE(%s, first_name), "
                    "last_name = COALESCE(%s, last_name) WHERE id = %s",
                    (body.first_name, body.last_name, pid),
                )
        else:
            cur.execute(
                "INSERT INTO player (usta_number, first_name, last_name) VALUES (%s,%s,%s) RETURNING id",
                (body.usta_number, body.first_name, body.last_name),
            )
            pid = cur.fetchone()["id"]

        # Put them on the roster (source=late_entry) if not already there.
        cur.execute(
            """
            INSERT INTO tournament_entry
                (tournament_id, player_id, age_division, events, selection_status, source)
            VALUES (%s, %s, %s, %s, 'selected', 'late_entry')
            ON CONFLICT (tournament_id, player_id) DO UPDATE
                SET age_division = COALESCE(EXCLUDED.age_division, tournament_entry.age_division),
                    events = COALESCE(EXCLUDED.events, tournament_entry.events)
            """,
            (tournament_id, pid, body.age_division, body.events),
        )

        cur.execute(
            """
            INSERT INTO late_entry
                (tournament_id, player_id, request_date, request_time, age_division,
                 events, source_email_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (tournament_id, pid, body.request_date, body.request_time,
             body.age_division, body.events, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]

        # Mark the source email filed, if provided.
        if body.source_email_id:
            cur.execute(
                "UPDATE email_message SET status = 'filed', classification = 'late_entry' WHERE id = %s",
                (body.source_email_id,),
            )

        cur.execute(_SELECT + " WHERE le.id = %s", (new_id,))
        return cur.fetchone()


@router.put("/api/late-entries/{entry_id}", response_model=LateEntryOut)
def update_late_entry(entry_id: int, body: LateEntryUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE late_entry SET age_division = %s, events = %s, request_date = %s, "
            "request_time = %s WHERE id = %s",
            (body.age_division, body.events, body.request_date, body.request_time, entry_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="late entry not found")
        cur.execute(_SELECT + " WHERE le.id = %s", (entry_id,))
        return cur.fetchone()


@router.delete("/api/late-entries/{entry_id}", status_code=204)
def delete_late_entry(entry_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM late_entry WHERE id = %s", (entry_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="late entry not found")
    return Response(status_code=204)
