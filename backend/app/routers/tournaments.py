import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import SiteIds, SiteOut, TournamentCreate, TournamentOut

router = APIRouter(prefix="/api/tournaments", tags=["tournaments"])

_COLS = (
    "id, name, type, play_start_date, play_end_date, "
    "registration_deadline, late_entry_deadline"
)
_SITE_COLS = "id, code, name, street, city, state, zip, lat, lng"


@router.get("", response_model=list[TournamentOut])
def list_tournaments(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM tournament ORDER BY id")
        return cur.fetchall()


@router.get("/{tournament_id}", response_model=TournamentOut)
def get_tournament(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM tournament WHERE id = %s", (tournament_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="tournament not found")
    return row


@router.post("", response_model=TournamentOut, status_code=201)
def create_tournament(body: TournamentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO tournament
                    (name, type, play_start_date, play_end_date,
                     registration_deadline, late_entry_deadline)
                VALUES
                    (%(name)s, %(type)s, %(play_start_date)s, %(play_end_date)s,
                     %(registration_deadline)s, %(late_entry_deadline)s)
                RETURNING {_COLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="tournament name already exists")


@router.put("/{tournament_id}", response_model=TournamentOut)
def update_tournament(tournament_id: int, body: TournamentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE tournament SET
                    name = %(name)s, type = %(type)s,
                    play_start_date = %(play_start_date)s,
                    play_end_date = %(play_end_date)s,
                    registration_deadline = %(registration_deadline)s,
                    late_entry_deadline = %(late_entry_deadline)s
                WHERE id = %(id)s
                RETURNING {_COLS}
                """,
                {**body.model_dump(), "id": tournament_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="tournament name already exists")
    if row is None:
        raise HTTPException(status_code=404, detail="tournament not found")
    return row


@router.delete("/{tournament_id}", status_code=204)
def delete_tournament(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM tournament WHERE id = %s", (tournament_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="tournament not found")
    return Response(status_code=204)


# ---------- Tournament <-> Site (M2M) ----------
@router.get("/{tournament_id}/sites", response_model=list[SiteOut])
def list_tournament_sites(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {", ".join("s." + c for c in _SITE_COLS.split(", "))}
            FROM tournament_site ts JOIN site s ON s.id = ts.site_id
            WHERE ts.tournament_id = %s ORDER BY s.id
            """,
            (tournament_id,),
        )
        return cur.fetchall()


@router.put("/{tournament_id}/sites", response_model=list[SiteOut])
def set_tournament_sites(tournament_id: int, body: SiteIds, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute("DELETE FROM tournament_site WHERE tournament_id = %s", (tournament_id,))
        for sid in dict.fromkeys(body.site_ids):  # de-dup, preserve order
            try:
                cur.execute(
                    "INSERT INTO tournament_site (tournament_id, site_id) VALUES (%s, %s)",
                    (tournament_id, sid),
                )
            except psycopg.errors.ForeignKeyViolation:
                raise HTTPException(status_code=400, detail=f"site_id {sid} does not exist")
    return list_tournament_sites(tournament_id, conn)
