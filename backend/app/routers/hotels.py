from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import HotelCreate, HotelOut

router = APIRouter(prefix="/api/hotels", tags=["hotels"])

_COLS = "id, name, website, street, city, state, zip, phone"


@router.get("", response_model=list[HotelOut])
def list_hotels(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM hotel ORDER BY name")
        return cur.fetchall()


@router.post("", response_model=HotelOut, status_code=201)
def create_hotel(body: HotelCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO hotel (name, website, street, city, state, zip, phone)
            VALUES (%(name)s, %(website)s, %(street)s, %(city)s, %(state)s,
                    %(zip)s, %(phone)s)
            RETURNING {_COLS}
            """,
            body.model_dump(),
        )
        return cur.fetchone()


@router.put("/{hotel_id}", response_model=HotelOut)
def update_hotel(hotel_id: int, body: HotelCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE hotel SET
                name = %(name)s, website = %(website)s, street = %(street)s,
                city = %(city)s, state = %(state)s, zip = %(zip)s, phone = %(phone)s
            WHERE id = %(id)s
            RETURNING {_COLS}
            """,
            {**body.model_dump(), "id": hotel_id},
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="hotel not found")
    return row


@router.delete("/{hotel_id}", status_code=204)
def delete_hotel(hotel_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM hotel WHERE id = %s", (hotel_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="hotel not found")
    return Response(status_code=204)
