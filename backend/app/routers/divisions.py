"""Setup catalog: divisions + events. Filterable by tournament_type so the
forms can request only what the active tournament needs (frontend further
narrows by player gender)."""
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ..db import db_dep
from ..models import (
    DivisionCreate,
    DivisionOut,
    TournamentEventCreate,
    TournamentEventOut,
)

router = APIRouter(tags=["divisions"])

_DCOLS = "id, code, label, tournament_type, gender, sort_order"
_ECOLS = "id, name, tournament_type, gender, sort_order"


# ---------- divisions ----------
@router.get("/api/divisions", response_model=list[DivisionOut])
def list_divisions(
    tournament_type: str | None = Query(None, description="filter to junior or adult"),
    conn=Depends(db_dep),
):
    with conn.cursor() as cur:
        if tournament_type:
            cur.execute(
                f"SELECT {_DCOLS} FROM division WHERE tournament_type = %s ORDER BY sort_order, code",
                (tournament_type,),
            )
        else:
            cur.execute(f"SELECT {_DCOLS} FROM division ORDER BY tournament_type, sort_order, code")
        return cur.fetchall()


@router.post("/api/divisions", response_model=DivisionOut, status_code=201)
def create_division(body: DivisionCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO division (code, label, tournament_type, gender, sort_order)
                VALUES (%(code)s, %(label)s, %(tournament_type)s, %(gender)s, %(sort_order)s)
                RETURNING {_DCOLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="division code already exists")


@router.put("/api/divisions/{div_id}", response_model=DivisionOut)
def update_division(div_id: int, body: DivisionCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE division SET
                    code = %(code)s, label = %(label)s,
                    tournament_type = %(tournament_type)s,
                    gender = %(gender)s, sort_order = %(sort_order)s
                WHERE id = %(id)s
                RETURNING {_DCOLS}
                """,
                {**body.model_dump(), "id": div_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="division code already exists")
    if row is None:
        raise HTTPException(status_code=404, detail="division not found")
    return row


@router.delete("/api/divisions/{div_id}", status_code=204)
def delete_division(div_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM division WHERE id = %s", (div_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="division not found")
    return Response(status_code=204)


# ---------- events ----------
@router.get("/api/events", response_model=list[TournamentEventOut])
def list_events(
    tournament_type: str | None = Query(None),
    conn=Depends(db_dep),
):
    with conn.cursor() as cur:
        if tournament_type:
            cur.execute(
                f"SELECT {_ECOLS} FROM tournament_event WHERE tournament_type = %s ORDER BY sort_order, name",
                (tournament_type,),
            )
        else:
            cur.execute(f"SELECT {_ECOLS} FROM tournament_event ORDER BY tournament_type, sort_order, name")
        return cur.fetchall()


@router.post("/api/events", response_model=TournamentEventOut, status_code=201)
def create_event(body: TournamentEventCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO tournament_event (name, tournament_type, gender, sort_order)
                VALUES (%(name)s, %(tournament_type)s, %(gender)s, %(sort_order)s)
                RETURNING {_ECOLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="event name already exists")


@router.put("/api/events/{event_id}", response_model=TournamentEventOut)
def update_event(event_id: int, body: TournamentEventCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE tournament_event SET
                    name = %(name)s,
                    tournament_type = %(tournament_type)s,
                    gender = %(gender)s, sort_order = %(sort_order)s
                WHERE id = %(id)s
                RETURNING {_ECOLS}
                """,
                {**body.model_dump(), "id": event_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="event name already exists")
    if row is None:
        raise HTTPException(status_code=404, detail="event not found")
    return row


@router.delete("/api/events/{event_id}", status_code=204)
def delete_event(event_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM tournament_event WHERE id = %s", (event_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="event not found")
    return Response(status_code=204)
