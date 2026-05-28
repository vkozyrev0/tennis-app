import psycopg
from fastapi import APIRouter, Depends, Header, HTTPException, Response

from ..db import db_dep
from ..models import PlayerCreate, PlayerHistoryOut, PlayerOut

router = APIRouter(prefix="/api/players", tags=["players"])

_COLS = "id, usta_number, first_name, last_name, gender, birthdate, city, state, updated_at"

# Audit F6: PlayerCreate is shared between POST and PUT bodies; the PUT path
# accepts spread `{**p, "city": "..."}` payloads that may carry id/updated_at,
# which Pydantic v2 silently ignores (default `extra="ignore"`). This is
# intentional — if anyone tightens to `extra="forbid"` later, every Setup PUT
# test breaks and the test naming becomes the contract.


@router.get("", response_model=list[PlayerOut])
def list_players(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM player ORDER BY last_name, first_name")
        return cur.fetchall()


@router.get("/{player_id}", response_model=PlayerOut)
def get_player(player_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM player WHERE id = %s", (player_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="player not found")
    return row


@router.get("/{player_id}/history", response_model=list[PlayerHistoryOut])
def player_history(player_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, player_id, usta_number, first_name, last_name, birthdate,
                   valid_from, valid_to, change_type
            FROM player_history WHERE player_id = %s ORDER BY valid_from DESC
            """,
            (player_id,),
        )
        return cur.fetchall()


@router.post("", response_model=PlayerOut, status_code=201)
def create_player(body: PlayerCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO player (usta_number, first_name, last_name, gender, birthdate, city, state)
                VALUES (%(usta_number)s, %(first_name)s, %(last_name)s, %(gender)s,
                        %(birthdate)s, %(city)s, %(state)s)
                RETURNING {_COLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="usta_number already exists")


@router.put("/{player_id}", response_model=PlayerOut)
def update_player(
    player_id: int,
    body: PlayerCreate,
    conn=Depends(db_dep),
    x_if_updated_at: str | None = Header(default=None, alias="X-If-Updated-At"),
):
    """Audit M19 + F5: optimistic concurrency via a custom `X-If-Updated-At`
    header carrying the ISO `updated_at` the client last saw. We switched
    away from `If-Unmodified-Since` because RFC 7232 defines that as an
    HTTP-date (RFC 1123); some proxies and WAFs reject ISO 8601 values, so
    a custom header is the portable choice. The header is optional —
    callers that don't care skip the check.

    The player_history trigger snapshots the prior values and bumps updated_at.
    """
    try:
        with conn.cursor() as cur:
            if x_if_updated_at:
                cur.execute(
                    "SELECT updated_at FROM player WHERE id = %s", (player_id,)
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="player not found")
                if row["updated_at"] and row["updated_at"].isoformat() != x_if_updated_at:
                    raise HTTPException(
                        status_code=409,
                        detail="player was modified elsewhere — reload and try again",
                    )
            cur.execute(
                f"""
                UPDATE player SET
                    usta_number = %(usta_number)s,
                    first_name = %(first_name)s,
                    last_name = %(last_name)s,
                    gender = %(gender)s,
                    birthdate = %(birthdate)s,
                    city = %(city)s,
                    state = %(state)s,
                    -- Audit M19: bump updated_at on every PUT so optimistic
                    -- concurrency works even for non-history-tracked fields
                    -- (the player_history trigger only records *name* changes).
                    updated_at = now()
                WHERE id = %(id)s
                RETURNING {_COLS}
                """,
                {**body.model_dump(), "id": player_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="usta_number already exists")
    if row is None:
        raise HTTPException(status_code=404, detail="player not found")
    return row


@router.delete("/{player_id}", status_code=204)
def delete_player(player_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM player WHERE id = %s", (player_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="player not found")
    return Response(status_code=204)
