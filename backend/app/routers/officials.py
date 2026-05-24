from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import OfficialCreate, OfficialOut

router = APIRouter(prefix="/api/officials", tags=["officials"])

_COLS = (
    "id, first_name, last_name, street, city, state, zip, phone, email, "
    "dietary_restrictions, lat, lng"
)


@router.get("", response_model=list[OfficialOut])
def list_officials(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM official ORDER BY last_name, first_name")
        return cur.fetchall()


@router.get("/{official_id}", response_model=OfficialOut)
def get_official(official_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM official WHERE id = %s", (official_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="official not found")
    return row


@router.post("", response_model=OfficialOut, status_code=201)
def create_official(body: OfficialCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO official
                (first_name, last_name, street, city, state, zip, phone, email,
                 dietary_restrictions, lat, lng)
            VALUES
                (%(first_name)s, %(last_name)s, %(street)s, %(city)s, %(state)s,
                 %(zip)s, %(phone)s, %(email)s, %(dietary_restrictions)s,
                 %(lat)s, %(lng)s)
            RETURNING {_COLS}
            """,
            body.model_dump(),
        )
        return cur.fetchone()


@router.put("/{official_id}", response_model=OfficialOut)
def update_official(official_id: int, body: OfficialCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE official SET
                first_name = %(first_name)s, last_name = %(last_name)s,
                street = %(street)s, city = %(city)s, state = %(state)s,
                zip = %(zip)s, phone = %(phone)s, email = %(email)s,
                dietary_restrictions = %(dietary_restrictions)s,
                lat = %(lat)s, lng = %(lng)s
            WHERE id = %(id)s
            RETURNING {_COLS}
            """,
            {**body.model_dump(), "id": official_id},
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="official not found")
    return row


@router.delete("/{official_id}", status_code=204)
def delete_official(official_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM official WHERE id = %s", (official_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="official not found")
    return Response(status_code=204)
