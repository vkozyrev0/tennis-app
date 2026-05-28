"""Doubles pairing (audit §2.2 / §3.6).

Mutual: a partnership verifies only when BOTH players' emails are on file, each
naming the other (same division). Random: FIFO queue per (tournament, division) —
the next random request pairs with the longest-waiting one; binding once made.
"""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import DoublesPairUpdate, DoublesRequestCreate, DoublesRequestUpdate
from ..playerops import mark_email_filed, upsert_player

router = APIRouter(tags=["doubles"])

_REQ = """
SELECT r.id, r.tournament_id, r.age_division, r.player_id, r.partner_usta,
       r.wants_random, r.status, r.source_email_id,
       p.usta_number, p.first_name, p.last_name
FROM doubles_request r JOIN player p ON p.id = r.player_id
"""
_PAIR = """
SELECT d.id, d.tournament_id, d.age_division, d.pairing_type, d.verified,
       d.player1_id, d.player2_id,
       NULLIF(concat_ws(', ', p1.last_name, p1.first_name), '') AS player1,
       NULLIF(concat_ws(', ', p2.last_name, p2.first_name), '') AS player2
FROM doubles_pair d
JOIN player p1 ON p1.id = d.player1_id
JOIN player p2 ON p2.id = d.player2_id
"""


def _make_pair(cur, tid, division, p1, p2, ptype):
    # Audit F15: both players must be on this tournament's roster. Random
    # pairing already implies that; mutual could reach here if a request named
    # a partner who never registered — refuse rather than make a phantom pair.
    cur.execute(
        "SELECT player_id FROM tournament_entry WHERE tournament_id = %s AND player_id IN (%s, %s)",
        (tid, p1, p2),
    )
    on_roster = {r["player_id"] for r in cur.fetchall()}
    missing = [pid for pid in (p1, p2) if pid not in on_roster]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"doubles pair members aren't on the tournament roster: {missing}",
        )
    cur.execute(
        "INSERT INTO doubles_pair (tournament_id, age_division, player1_id, player2_id, "
        "pairing_type, verified) VALUES (%s,%s,%s,%s,%s,true) RETURNING id",
        (tid, division, p1, p2, ptype),
    )
    return cur.fetchone()["id"]


@router.get("/api/tournaments/{tournament_id}/doubles")
def list_doubles(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_REQ + " WHERE r.tournament_id = %s ORDER BY r.created_at", (tournament_id,))
        requests = cur.fetchall()
        cur.execute(_PAIR + " WHERE d.tournament_id = %s ORDER BY d.id", (tournament_id,))
        pairs = cur.fetchall()
    return {"requests": requests, "pairs": pairs}


@router.post("/api/tournaments/{tournament_id}/doubles-requests", status_code=201)
def create_doubles_request(tournament_id: int, body: DoublesRequestCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        # Random pairing is per-division FIFO, so a division is required — otherwise
        # NULL-division requests would pair across divisions (audit §3.6).
        if body.wants_random and not (body.age_division or "").strip():
            raise HTTPException(status_code=400, detail="random pairing requires an age division")
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name, body.gender)
        partner = (body.partner_usta or "").strip() or None
        cur.execute(
            """
            INSERT INTO doubles_request
                (tournament_id, age_division, player_id, partner_usta, wants_random, source_email_id)
            VALUES (%s,%s,%s,%s,%s,%s) RETURNING id
            """,
            (tournament_id, body.age_division, pid, partner, body.wants_random, body.source_email_id),
        )
        req_id = cur.fetchone()["id"]
        mark_email_filed(cur, body.source_email_id, "doubles")

        paired_id = None
        if body.wants_random:
            # FIFO: pair with the oldest pending random request in this division.
            cur.execute(
                """
                SELECT id, player_id FROM doubles_request
                WHERE tournament_id = %s AND age_division IS NOT DISTINCT FROM %s
                  AND wants_random = true AND status = 'pending'
                  AND id <> %s AND player_id <> %s
                ORDER BY created_at LIMIT 1
                """,
                (tournament_id, body.age_division, req_id, pid),
            )
            match = cur.fetchone()
            if match:
                _make_pair(cur, tournament_id, body.age_division, match["player_id"], pid, "random")
                cur.execute("UPDATE doubles_request SET status='paired' WHERE id IN (%s,%s)", (match["id"], req_id))
                paired_id = match["id"]
        elif partner:
            # Reciprocal mutual match: a pending request from the named partner that
            # names THIS player back, same division.
            cur.execute(
                """
                SELECT r.id, r.player_id FROM doubles_request r JOIN player p ON p.id = r.player_id
                WHERE r.tournament_id = %s AND r.age_division IS NOT DISTINCT FROM %s
                  AND r.wants_random = false AND r.status = 'pending' AND r.id <> %s
                  AND p.usta_number = %s AND r.partner_usta = %s
                ORDER BY r.created_at LIMIT 1
                """,
                (tournament_id, body.age_division, req_id, partner, body.usta_number),
            )
            match = cur.fetchone()
            if match:
                _make_pair(cur, tournament_id, body.age_division, match["player_id"], pid, "mutual")
                cur.execute("UPDATE doubles_request SET status='paired' WHERE id IN (%s,%s)", (match["id"], req_id))
                paired_id = match["id"]

        cur.execute(_REQ + " WHERE r.id = %s", (req_id,))
        request = cur.fetchone()
    return {"request": request, "paired": paired_id is not None}


@router.put("/api/doubles-requests/{req_id}")
def update_request(req_id: int, body: DoublesRequestUpdate, conn=Depends(db_dep)):
    """Edit a request's `age_division`. Player / partner / random / verification
    stay system-managed — to change those, delete and re-file.

    Audit F16: once the request is paired, editing its division here would
    diverge from `doubles_pair.age_division` (which is what scheduling reads).
    Either both must move together or neither. Keep it simple: refuse.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM doubles_request WHERE id = %s", (req_id,))
        existing = cur.fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="not found")
        if existing["status"] == "paired":
            raise HTTPException(
                status_code=409,
                detail="request is already paired — edit the pair's division instead",
            )
        cur.execute(
            "UPDATE doubles_request SET age_division = %s WHERE id = %s",
            (body.age_division, req_id),
        )
        cur.execute(_REQ + " WHERE r.id = %s", (req_id,))
        return cur.fetchone()


@router.put("/api/doubles-pairs/{pair_id}")
def update_pair(pair_id: int, body: DoublesPairUpdate, conn=Depends(db_dep)):
    """Edit a verified pair's `age_division`. Members / pairing_type stay fixed."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE doubles_pair SET age_division = %s WHERE id = %s",
            (body.age_division, pair_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
        cur.execute(_PAIR + " WHERE d.id = %s", (pair_id,))
        return cur.fetchone()


@router.delete("/api/doubles-requests/{req_id}", status_code=204)
def delete_request(req_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM doubles_request WHERE id = %s", (req_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


@router.delete("/api/doubles-pairs/{pair_id}", status_code=204)
def delete_pair(pair_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM doubles_pair WHERE id = %s", (pair_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)
