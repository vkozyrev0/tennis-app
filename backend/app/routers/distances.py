import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import DistanceCreate, DistanceOut

router = APIRouter(prefix="/api/distances", tags=["distances"])

_COLS = "id, official_id, site_id, one_way_miles, source"


@router.get("", response_model=list[DistanceOut])
def list_distances(official_id: int | None = None, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        if official_id is None:
            cur.execute(f"SELECT {_COLS} FROM official_site_distance ORDER BY id")
        else:
            cur.execute(
                f"SELECT {_COLS} FROM official_site_distance WHERE official_id = %s ORDER BY id",
                (official_id,),
            )
        return cur.fetchall()


@router.post("", response_model=DistanceOut, status_code=201)
def create_distance(body: DistanceCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO official_site_distance (official_id, site_id, one_way_miles, source)
                VALUES (%(official_id)s, %(site_id)s, %(one_way_miles)s, %(source)s)
                RETURNING {_COLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="distance for this official/site exists")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id or site_id does not exist")


@router.put("/{distance_id}", response_model=DistanceOut)
def update_distance(distance_id: int, body: DistanceCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE official_site_distance SET
                    official_id = %(official_id)s, site_id = %(site_id)s,
                    one_way_miles = %(one_way_miles)s, source = %(source)s
                WHERE id = %(id)s
                RETURNING {_COLS}
                """,
                {**body.model_dump(), "id": distance_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="distance for this official/site exists")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id or site_id does not exist")
    if row is None:
        raise HTTPException(status_code=404, detail="distance not found")
    return row


@router.delete("/{distance_id}", status_code=204)
def delete_distance(distance_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM official_site_distance WHERE id = %s", (distance_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="distance not found")
    return Response(status_code=204)
