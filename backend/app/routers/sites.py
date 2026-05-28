import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import SiteCreate, SiteOut

router = APIRouter(prefix="/api/sites", tags=["sites"])

_COLS = "id, code, name, street, city, state, zip, lat, lng"


@router.get("", response_model=list[SiteOut])
def list_sites(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM site ORDER BY id")
        return cur.fetchall()


@router.get("/{site_id}", response_model=SiteOut)
def get_site(site_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM site WHERE id = %s", (site_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="site not found")
    return row


@router.post("", response_model=SiteOut, status_code=201)
def create_site(body: SiteCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO site (code, name, street, city, state, zip, lat, lng)
                VALUES (%(code)s, %(name)s, %(street)s, %(city)s, %(state)s,
                        %(zip)s, %(lat)s, %(lng)s)
                RETURNING {_COLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="site code already exists")


@router.put("/{site_id}", response_model=SiteOut)
def update_site(site_id: int, body: SiteCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE site SET
                    code = %(code)s, name = %(name)s, street = %(street)s,
                    city = %(city)s, state = %(state)s, zip = %(zip)s,
                    lat = %(lat)s, lng = %(lng)s
                WHERE id = %(id)s
                RETURNING {_COLS}
                """,
                {**body.model_dump(), "id": site_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="site code already exists")
    if row is None:
        raise HTTPException(status_code=404, detail="site not found")
    return row


@router.delete("/{site_id}", status_code=204)
def delete_site(site_id: int, conn=Depends(db_dep)):
    # tournament.site_id is ON DELETE SET NULL, so referencing tournaments survive.
    with conn.cursor() as cur:
        cur.execute("DELETE FROM site WHERE id = %s", (site_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="site not found")
    return Response(status_code=204)
