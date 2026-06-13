import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..geocode import road_one_way_miles
from ..models import DistanceAuto, DistanceCreate, DistanceOut

router = APIRouter(prefix="/api/distances", tags=["distances"])

_COLS = "id, official_id, site_id, one_way_miles, source"


@router.post("/auto", response_model=DistanceOut, status_code=201)
def auto_distance(body: DistanceAuto, conn=Depends(db_dep)):
    """Compute official↔site one-way driving miles from stored coordinates and
    upsert it. Uses the Google Distance Matrix API when GOOGLE_MAPS_API_KEY is
    set (source `maps`, authoritative); otherwise a great-circle estimate × a
    road factor (source `geocoded`, key-free fallback — review before it drives
    reimbursement). Returns 422 when the official or site has no coordinates on
    file (enter them, or use manual distance entry). See app/geocode.py."""
    with conn.cursor() as cur:
        cur.execute("SELECT lat, lng FROM official WHERE id = %s", (body.official_id,))
        o = cur.fetchone()
        if o is None:
            raise HTTPException(status_code=404, detail="official not found")
        cur.execute("SELECT lat, lng FROM site WHERE id = %s", (body.site_id,))
        s = cur.fetchone()
        if s is None:
            raise HTTPException(status_code=404, detail="site not found")
        if None in (o["lat"], o["lng"], s["lat"], s["lng"]):
            raise HTTPException(
                status_code=422,
                detail="official or site is missing coordinates — add them, or enter the distance manually",
            )
        miles, source = road_one_way_miles(
            float(o["lat"]), float(o["lng"]),
            float(s["lat"]), float(s["lng"]),
        )
        # Upsert: re-computing overwrites a prior value for the pair. source is
        # 'maps' (API) or 'geocoded' (estimate) per road_one_way_miles.
        cur.execute(
            f"""
            INSERT INTO official_site_distance (official_id, site_id, one_way_miles, source)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (official_id, site_id)
            DO UPDATE SET one_way_miles = EXCLUDED.one_way_miles, source = EXCLUDED.source
            RETURNING {_COLS}
            """,
            (body.official_id, body.site_id, miles, source),
        )
        return cur.fetchone()


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
