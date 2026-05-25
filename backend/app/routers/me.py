"""Official self-service surface (/api/me/*) — the logged-in official's own
profile and availability. Officials never touch the admin routers."""
from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from ..models import MyAvailabilitySet, OfficialCreate
from ..security import get_current_user

router = APIRouter(prefix="/api/me", tags=["me"])

_OFF_COLS = (
    "id, first_name, last_name, street, city, state, zip, phone, email, "
    "dietary_restrictions, lat, lng"
)


def _my_official_id(user: dict) -> int:
    if user["role"] == "official" and user["official_id"]:
        return user["official_id"]
    raise HTTPException(status_code=403, detail="no official profile is linked to this account")


@router.get("")
def my_profile(user=Depends(get_current_user), conn=Depends(db_dep)):
    oid = _my_official_id(user)
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_OFF_COLS} FROM official WHERE id = %s", (oid,))
        official = cur.fetchone()
    return {"username": user["username"], "role": user["role"], "official": official}


@router.put("/profile")
def update_my_profile(body: OfficialCreate, user=Depends(get_current_user), conn=Depends(db_dep)):
    oid = _my_official_id(user)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE official SET
                first_name=%(first_name)s, last_name=%(last_name)s, street=%(street)s,
                city=%(city)s, state=%(state)s, zip=%(zip)s, phone=%(phone)s,
                email=%(email)s, dietary_restrictions=%(dietary_restrictions)s
            WHERE id=%(id)s RETURNING {_OFF_COLS}
            """,
            {**body.model_dump(), "id": oid},
        )
        return cur.fetchone()


@router.get("/tournaments")
def my_tournaments(user=Depends(get_current_user), conn=Depends(db_dep)):
    _my_official_id(user)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, type, play_start_date, play_end_date "
            "FROM tournament ORDER BY play_start_date DESC"
        )
        return cur.fetchall()


@router.get("/availability/{tournament_id}")
def my_availability(tournament_id: int, user=Depends(get_current_user), conn=Depends(db_dep)):
    oid = _my_official_id(user)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT available_date, hotel_needed FROM availability "
            "WHERE official_id = %s AND tournament_id = %s ORDER BY available_date",
            (oid, tournament_id),
        )
        rows = cur.fetchall()
    return {
        "dates": [r["available_date"].isoformat() for r in rows],
        "hotel_needed": any(r["hotel_needed"] for r in rows),
    }


@router.put("/availability/{tournament_id}")
def set_my_availability(tournament_id: int, body: MyAvailabilitySet,
                        user=Depends(get_current_user), conn=Depends(db_dep)):
    oid = _my_official_id(user)
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM availability WHERE official_id = %s AND tournament_id = %s",
            (oid, tournament_id),
        )
        for d in body.dates:
            cur.execute(
                "INSERT INTO availability (official_id, tournament_id, available_date, hotel_needed) "
                "VALUES (%s, %s, %s, %s)",
                (oid, tournament_id, d, body.hotel_needed),
            )
    return {"dates": [d.isoformat() for d in body.dates], "hotel_needed": body.hotel_needed}
