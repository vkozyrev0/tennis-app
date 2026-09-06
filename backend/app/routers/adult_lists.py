"""Adult-tournament Part B lists: scheduling avoidances + division flexibility."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..query_helpers import like_escape, paged_select, person_like_sql
from ..models import (
    DivFlexCreate,
    DivFlexOut,
    DivFlexUpdate,
    SchedAvoidCreate,
    SchedAvoidOut,
    SchedAvoidUpdate,
)
from ..playerops import mark_email_filed, upsert_player

router = APIRouter(tags=["adult-lists"])

_SA_COLS = """
a.id, a.tournament_id, a.player_id, a.avoid_day, a.avoid_time_range,
       a.source_email_id, em.subject AS source_subject,
       p.usta_number, p.first_name, p.last_name
"""
_SA_FROM = """
FROM scheduling_avoidance a JOIN player p ON p.id = a.player_id
LEFT JOIN email_message em ON em.id = a.source_email_id
"""
_SA = f"SELECT {_SA_COLS} {_SA_FROM}"
_DF_COLS = """
d.id, d.tournament_id, d.player_id, d.home_division, d.willing_divisions,
       d.source_email_id, em.subject AS source_subject,
       p.usta_number, p.first_name, p.last_name
"""
_DF_FROM = """
FROM division_flexibility d JOIN player p ON p.id = d.player_id
LEFT JOIN email_message em ON em.id = d.source_email_id
"""
_DF = f"SELECT {_DF_COLS} {_DF_FROM}"


def _tournament_or_404(cur, tid):
    cur.execute("SELECT id FROM tournament WHERE id = %s", (tid,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="tournament not found")


# ---- scheduling avoidances ----
@router.get("/api/tournaments/{tournament_id}/scheduling-avoidances", response_model=list[SchedAvoidOut])
def list_sched(tournament_id: int, response: Response, q: str | None = None,
               limit: int | None = None, offset: int = 0, conn=Depends(db_dep)):
    clauses, params = ["a.tournament_id = %s"], [tournament_id]
    if q:
        sql, n = person_like_sql("p")
        clauses.append(sql)
        params += [f"%{like_escape(q.strip())}%"] * n
    where = " WHERE " + " AND ".join(clauses)
    with conn.cursor() as cur:
        return paged_select(cur, response, cols=_SA_COLS, from_sql=_SA_FROM,
                            where=where, params=params,
                            order_by=" ORDER BY a.id",
                            limit=limit, offset=offset)


@router.post("/api/tournaments/{tournament_id}/scheduling-avoidances",
             response_model=SchedAvoidOut, status_code=201)
def create_sched(tournament_id: int, body: SchedAvoidCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _tournament_or_404(cur, tournament_id)
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name, body.gender)
        cur.execute(
            "INSERT INTO scheduling_avoidance (tournament_id, player_id, avoid_day, "
            "avoid_time_range, source_email_id) VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (tournament_id, pid, body.avoid_day, body.avoid_time_range, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]
        mark_email_filed(cur, body.source_email_id, "scheduling_avoidance")
        cur.execute(_SA + " WHERE a.id = %s", (new_id,))
        return cur.fetchone()


@router.put("/api/scheduling-avoidances/{row_id}", response_model=SchedAvoidOut)
def update_sched(row_id: int, body: SchedAvoidUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE scheduling_avoidance SET avoid_day = %s, avoid_time_range = %s WHERE id = %s",
            (body.avoid_day, body.avoid_time_range, row_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
        cur.execute(_SA + " WHERE a.id = %s", (row_id,))
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
def list_divflex(tournament_id: int, response: Response, q: str | None = None,
                 limit: int | None = None, offset: int = 0, conn=Depends(db_dep)):
    clauses, params = ["d.tournament_id = %s"], [tournament_id]
    if q:
        sql, n = person_like_sql("p")
        clauses.append(sql)
        params += [f"%{like_escape(q.strip())}%"] * n
    where = " WHERE " + " AND ".join(clauses)
    with conn.cursor() as cur:
        return paged_select(cur, response, cols=_DF_COLS, from_sql=_DF_FROM,
                            where=where, params=params,
                            order_by=" ORDER BY d.id",
                            limit=limit, offset=offset)


@router.post("/api/tournaments/{tournament_id}/division-flex",
             response_model=DivFlexOut, status_code=201)
def create_divflex(tournament_id: int, body: DivFlexCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _tournament_or_404(cur, tournament_id)
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name, body.gender)
        cur.execute(
            "INSERT INTO division_flexibility (tournament_id, player_id, home_division, "
            "willing_divisions, source_email_id) VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (tournament_id, pid, body.home_division, body.willing_divisions, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]
        mark_email_filed(cur, body.source_email_id, "division_flex")
        cur.execute(_DF + " WHERE d.id = %s", (new_id,))
        return cur.fetchone()


@router.put("/api/division-flex/{row_id}", response_model=DivFlexOut)
def update_divflex(row_id: int, body: DivFlexUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE division_flexibility SET home_division = %s, willing_divisions = %s WHERE id = %s",
            (body.home_division, body.willing_divisions, row_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
        cur.execute(_DF + " WHERE d.id = %s", (row_id,))
        return cur.fetchone()


@router.delete("/api/division-flex/{row_id}", status_code=204)
def delete_divflex(row_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM division_flexibility WHERE id = %s", (row_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)
