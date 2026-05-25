"""Adult-tournament Part B lists: scheduling avoidances + division flexibility."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import DivFlexCreate, DivFlexOut, SchedAvoidCreate, SchedAvoidOut
from ..playerops import mark_email_filed, upsert_player

router = APIRouter(tags=["adult-lists"])

_SA = """
SELECT a.id, a.tournament_id, a.player_id, a.avoid_day, a.avoid_time_range,
       a.source_email_id, p.usta_number, p.first_name, p.last_name
FROM scheduling_avoidance a JOIN player p ON p.id = a.player_id
"""
_DF = """
SELECT d.id, d.tournament_id, d.player_id, d.home_division, d.willing_divisions,
       d.source_email_id, p.usta_number, p.first_name, p.last_name
FROM division_flexibility d JOIN player p ON p.id = d.player_id
"""


def _tournament_or_404(cur, tid):
    cur.execute("SELECT id FROM tournament WHERE id = %s", (tid,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="tournament not found")


# ---- scheduling avoidances ----
@router.get("/api/tournaments/{tournament_id}/scheduling-avoidances", response_model=list[SchedAvoidOut])
def list_sched(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_SA + " WHERE a.tournament_id = %s ORDER BY a.id", (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/scheduling-avoidances",
             response_model=SchedAvoidOut, status_code=201)
def create_sched(tournament_id: int, body: SchedAvoidCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _tournament_or_404(cur, tournament_id)
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name)
        cur.execute(
            "INSERT INTO scheduling_avoidance (tournament_id, player_id, avoid_day, "
            "avoid_time_range, source_email_id) VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (tournament_id, pid, body.avoid_day, body.avoid_time_range, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]
        mark_email_filed(cur, body.source_email_id, "scheduling_avoidance")
        cur.execute(_SA + " WHERE a.id = %s", (new_id,))
        return cur.fetchone()


@router.delete("/api/scheduling-avoidances/{row_id}", status_code=204)
def delete_sched(row_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM scheduling_avoidance WHERE id = %s", (row_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


# ---- division flexibility ----
@router.get("/api/tournaments/{tournament_id}/division-flex", response_model=list[DivFlexOut])
def list_divflex(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_DF + " WHERE d.tournament_id = %s ORDER BY d.id", (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/division-flex",
             response_model=DivFlexOut, status_code=201)
def create_divflex(tournament_id: int, body: DivFlexCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _tournament_or_404(cur, tournament_id)
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name)
        cur.execute(
            "INSERT INTO division_flexibility (tournament_id, player_id, home_division, "
            "willing_divisions, source_email_id) VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (tournament_id, pid, body.home_division, body.willing_divisions, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]
        mark_email_filed(cur, body.source_email_id, "division_flex")
        cur.execute(_DF + " WHERE d.id = %s", (new_id,))
        return cur.fetchone()


@router.delete("/api/division-flex/{row_id}", status_code=204)
def delete_divflex(row_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM division_flexibility WHERE id = %s", (row_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)
