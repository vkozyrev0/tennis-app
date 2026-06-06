import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import AccountCreate, OfficialCreate, OfficialOut
from ..security import hash_pw

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


# NOTE: declared BEFORE GET /{official_id} so "/search" isn't parsed as an id.
@router.get("/search")
def search_officials(q: str, limit: int = 10, conn=Depends(db_dep)):
    """Global official lookup by name, for the top-bar search → official overview.
    Names are plaintext; returns a lightweight shape (no contact)."""
    term = (q or "").strip()
    if len(term) < 2:
        return []
    like = f"%{term}%"
    limit = max(1, min(limit, 50))
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, first_name, last_name, city, state FROM official "
            "WHERE first_name ILIKE %(l)s OR last_name ILIKE %(l)s "
            "   OR (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE %(l)s "
            "   OR (COALESCE(last_name,'')  || ', ' || COALESCE(first_name,'')) ILIKE %(l)s "
            "ORDER BY last_name, first_name LIMIT %(lim)s",
            {"l": like, "lim": limit},
        )
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


@router.put("/{official_id}/account", status_code=200)
def set_official_account(official_id: int, body: AccountCreate, conn=Depends(db_dep)):
    """Admin: create or reset the login for an official (role=official)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM official WHERE id = %s", (official_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="official not found")
        # Audit N4: the old ON CONFLICT (username) DO UPDATE let an admin
        # overwrite ANY existing user_account (including the admin account
        # itself) and bind it to a different official_id. Refuse the conflict
        # when the existing row belongs to a different official.
        cur.execute(
            "SELECT id, role, official_id FROM user_account WHERE username = %s",
            (body.username,),
        )
        existing = cur.fetchone()
        if existing and (existing["role"] != "official"
                         or (existing["official_id"] is not None
                             and existing["official_id"] != official_id)):
            raise HTTPException(status_code=409, detail="username already in use")
        try:
            cur.execute(
                """
                INSERT INTO user_account (username, password_hash, role, official_id)
                VALUES (%s, %s, 'official', %s)
                ON CONFLICT (username) DO UPDATE
                    SET password_hash = EXCLUDED.password_hash,
                        role = 'official', official_id = EXCLUDED.official_id
                RETURNING id, username
                """,
                (body.username, hash_pw(body.password), official_id),
            )
            row = cur.fetchone()
        except psycopg.errors.UniqueViolation:
            raise HTTPException(status_code=409, detail="username already in use")
        # Setting/resetting the login invalidates any existing sessions for that
        # account, so a credential change forces a fresh login (audit follow-up).
        cur.execute("DELETE FROM session WHERE user_id = %s", (row["id"],))
    return {"id": row["id"], "username": row["username"], "official_id": official_id}
