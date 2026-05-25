import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import PlayerCreate, PlayerHistoryOut, PlayerOut

router = APIRouter(prefix="/api/players", tags=["players"])

_COLS = "id, usta_number, first_name, last_name, birthdate, updated_at"


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
                INSERT INTO player (usta_number, first_name, last_name, birthdate)
                VALUES (%(usta_number)s, %(first_name)s, %(last_name)s, %(birthdate)s)
                RETURNING {_COLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="usta_number already exists")


@router.put("/{player_id}", response_model=PlayerOut)
def update_player(player_id: int, body: PlayerCreate, conn=Depends(db_dep)):
    # The player_history trigger snapshots the prior values and bumps updated_at.
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE player SET
                    usta_number = %(usta_number)s,
                    first_name = %(first_name)s,
                    last_name = %(last_name)s,
                    birthdate = %(birthdate)s
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
