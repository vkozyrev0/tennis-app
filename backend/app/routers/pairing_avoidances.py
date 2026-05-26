"""Pairing avoidances (juniors, audit §1.1): a group of 2+ players who must not
meet in the first round (same club / siblings)."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import PairingAvoidanceCreate, PairingAvoidanceOut, PairingAvoidanceUpdate
from ..playerops import mark_email_filed, upsert_player

router = APIRouter(tags=["pairing-avoidances"])


def _members(cur, group_id):
    cur.execute(
        """
        SELECT m.player_id, p.usta_number, p.first_name, p.last_name
        FROM pairing_avoidance_member m JOIN player p ON p.id = m.player_id
        WHERE m.pairing_avoidance_id = %s ORDER BY p.last_name, p.first_name
        """,
        (group_id,),
    )
    return cur.fetchall()


def _group(cur, group_id):
    cur.execute(
        "SELECT id, tournament_id, age_division, relationship, source_email_id "
        "FROM pairing_avoidance WHERE id = %s",
        (group_id,),
    )
    g = cur.fetchone()
    if g is None:
        return None
    g["members"] = _members(cur, group_id)
    return g


@router.get("/api/tournaments/{tournament_id}/pairing-avoidances",
            response_model=list[PairingAvoidanceOut])
def list_pairing(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM pairing_avoidance WHERE tournament_id = %s ORDER BY id",
            (tournament_id,),
        )
        return [_group(cur, r["id"]) for r in cur.fetchall()]


@router.post("/api/tournaments/{tournament_id}/pairing-avoidances",
             response_model=PairingAvoidanceOut, status_code=201)
def create_pairing(tournament_id: int, body: PairingAvoidanceCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "INSERT INTO pairing_avoidance (tournament_id, age_division, relationship, source_email_id) "
            "VALUES (%s,%s,%s,%s) RETURNING id",
            (tournament_id, body.age_division, body.relationship, body.source_email_id),
        )
        gid = cur.fetchone()["id"]
        seen = set()
        for m in body.members:
            pid = upsert_player(cur, m.usta_number, m.first_name, m.last_name)
            if pid in seen:
                continue
            seen.add(pid)
            cur.execute(
                "INSERT INTO pairing_avoidance_member (pairing_avoidance_id, player_id) VALUES (%s,%s)",
                (gid, pid),
            )
        mark_email_filed(cur, body.source_email_id, "pairing_avoidance")
        return _group(cur, gid)


@router.put("/api/pairing-avoidances/{group_id}", response_model=PairingAvoidanceOut)
def update_pairing(group_id: int, body: PairingAvoidanceUpdate, conn=Depends(db_dep)):
    """Edit the group's `age_division` / `relationship`. Membership stays managed
    via add (POST) + delete; changing who's in a group means delete + re-add."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE pairing_avoidance SET age_division = %s, relationship = %s WHERE id = %s",
            (body.age_division, body.relationship, group_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
        return _group(cur, group_id)


@router.delete("/api/pairing-avoidances/{group_id}", status_code=204)
def delete_pairing(group_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM pairing_avoidance WHERE id = %s", (group_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)
