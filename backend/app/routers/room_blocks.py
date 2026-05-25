import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import RoomBlockCreate, RoomBlockOut

router = APIRouter(prefix="/api/room-blocks", tags=["room-blocks"])

_COLS = (
    "id, hotel_id, tournament_id, kind, confirmation_number, cancellation_info, "
    "check_in, check_out, room_count"
)

_INSERT = f"""
INSERT INTO room_block
    (hotel_id, tournament_id, kind, confirmation_number, cancellation_info,
     check_in, check_out, room_count)
VALUES
    (%(hotel_id)s, %(tournament_id)s, %(kind)s, %(confirmation_number)s,
     %(cancellation_info)s, %(check_in)s, %(check_out)s, %(room_count)s)
RETURNING {_COLS}
"""

_UPDATE = f"""
UPDATE room_block SET
    hotel_id = %(hotel_id)s, tournament_id = %(tournament_id)s, kind = %(kind)s,
    confirmation_number = %(confirmation_number)s,
    cancellation_info = %(cancellation_info)s, check_in = %(check_in)s,
    check_out = %(check_out)s, room_count = %(room_count)s
WHERE id = %(id)s
RETURNING {_COLS}
"""


_LIST_COLS = (
    _COLS
    + ", room_count - (SELECT count(*) FROM assignment a "
    "WHERE a.room_block_id = room_block.id) AS rooms_remaining"
)


@router.get("", response_model=list[RoomBlockOut])
def list_room_blocks(tournament_id: int | None = None, kind: str | None = None,
                     conn=Depends(db_dep)):
    clauses, params = [], []
    if tournament_id is not None:
        clauses.append("tournament_id = %s"); params.append(tournament_id)
    if kind is not None:
        clauses.append("kind = %s"); params.append(kind)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_LIST_COLS} FROM room_block{where} ORDER BY id", params)
        return cur.fetchall()


def _with_remaining(cur, block_id: int):
    """Re-read a block including the computed rooms_remaining (consistency with list)."""
    cur.execute(f"SELECT {_LIST_COLS} FROM room_block WHERE id = %s", (block_id,))
    return cur.fetchone()


@router.post("", response_model=RoomBlockOut, status_code=201)
def create_room_block(body: RoomBlockCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(_INSERT, body.model_dump())
            return _with_remaining(cur, cur.fetchone()["id"])
    except psycopg.errors.ForeignKeyViolation as e:
        raise HTTPException(status_code=400, detail=_fk_detail(e))


@router.put("/{block_id}", response_model=RoomBlockOut)
def update_room_block(block_id: int, body: RoomBlockCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(_UPDATE, {**body.model_dump(), "id": block_id})
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="room block not found")
            return _with_remaining(cur, block_id)
    except psycopg.errors.ForeignKeyViolation as e:
        raise HTTPException(status_code=400, detail=_fk_detail(e))


@router.delete("/{block_id}", status_code=204)
def delete_room_block(block_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM room_block WHERE id = %s", (block_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="room block not found")
    return Response(status_code=204)


def _fk_detail(e: Exception) -> str:
    msg = str(e)
    if "hotel" in msg:
        return "hotel_id does not exist"
    if "tournament" in msg:
        return "tournament_id does not exist"
    return "invalid reference"
