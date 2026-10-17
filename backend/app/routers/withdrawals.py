"""Withdrawals (Part B, audit §2.4). Reason required unless the player was an
alternate; recording flips the roster status to 'withdrawn' and (if filed from an
email) marks that email filed."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import WithdrawalCreate, WithdrawalOut, WithdrawalUpdate
from ..playerops import mark_email_filed, upsert_player
from ..query_helpers import like_escape, paged_select, person_like_sql

router = APIRouter(tags=["withdrawals"])

_COLS = """
w.id, w.tournament_id, w.player_id, w.events, w.reason, w.notes,
       w.was_alternate, w.source_email_id, em.subject AS source_subject,
       p.usta_number, p.first_name, p.last_name, te.age_division
"""
_FROM = """
FROM withdrawal w
JOIN player p ON p.id = w.player_id
LEFT JOIN tournament_entry te
       ON te.tournament_id = w.tournament_id AND te.player_id = w.player_id
LEFT JOIN email_message em ON em.id = w.source_email_id
"""
_SELECT = f"SELECT {_COLS} {_FROM}"


@router.get("/api/tournaments/{tournament_id}/withdrawals", response_model=list[WithdrawalOut])
def list_withdrawals(tournament_id: int, response: Response, q: str | None = None,
                     limit: int | None = None, offset: int = 0, conn=Depends(db_dep)):
    clauses, params = ["w.tournament_id = %s"], [tournament_id]
    if q:
        sql, n = person_like_sql("p")
        clauses.append(sql)
        params += [f"%{like_escape(q.strip())}%"] * n
    where = " WHERE " + " AND ".join(clauses)
    with conn.cursor() as cur:
        return paged_select(cur, response, cols=_COLS, from_sql=_FROM,
                            where=where, params=params,
                            order_by=" ORDER BY w.id",
                            limit=limit, offset=offset)


@router.post("/api/tournaments/{tournament_id}/withdrawals",
             response_model=WithdrawalOut, status_code=201)
def create_withdrawal(tournament_id: int, body: WithdrawalCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")

        # Audit M6: consolidated on the shared helper (refuses unknown players
        # without a gender; updates name on existing ones).
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name, body.gender)

        # Was the player an alternate? (read before we flip the status)
        cur.execute(
            "SELECT selection_status FROM tournament_entry "
            "WHERE tournament_id = %s AND player_id = %s",
            (tournament_id, pid),
        )
        entry = cur.fetchone()
        was_alternate = bool(entry and entry["selection_status"] == "alternate")
        prior_status = entry["selection_status"] if entry else None

        # Reason rule (§2.4): required unless they were an alternate.
        if not was_alternate and not (body.reason and body.reason.strip()):
            raise HTTPException(
                status_code=400,
                detail="a reason is required unless the player was an alternate",
            )

        if entry:
            cur.execute(
                "UPDATE tournament_entry SET selection_status = 'withdrawn' "
                "WHERE tournament_id = %s AND player_id = %s",
                (tournament_id, pid),
            )

        cur.execute(
            """
            INSERT INTO withdrawal
                (tournament_id, player_id, events, reason, notes, was_alternate,
                 prior_status, source_email_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (tournament_id, pid, body.events, body.reason, body.notes,
             was_alternate, prior_status, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]

        # Audit F7: use the shared helper instead of an inline UPDATE.
        mark_email_filed(cur, body.source_email_id, "withdrawal")

        cur.execute(_SELECT + " WHERE w.id = %s", (new_id,))
        return cur.fetchone()


@router.put("/api/withdrawals/{withdrawal_id}", response_model=WithdrawalOut)
def update_withdrawal(withdrawal_id: int, body: WithdrawalUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT was_alternate FROM withdrawal WHERE id = %s", (withdrawal_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="withdrawal not found")
        # Reason rule (§2.4): required unless the player was an alternate.
        if not row["was_alternate"] and not (body.reason and body.reason.strip()):
            raise HTTPException(
                status_code=400,
                detail="a reason is required unless the player was an alternate",
            )
        cur.execute(
            "UPDATE withdrawal SET events = %s, reason = %s, notes = %s WHERE id = %s",
            (body.events, body.reason, body.notes, withdrawal_id),
        )
        cur.execute(_SELECT + " WHERE w.id = %s", (withdrawal_id,))
        return cur.fetchone()


@router.delete("/api/withdrawals/{withdrawal_id}", status_code=204)
def delete_withdrawal(withdrawal_id: int, conn=Depends(db_dep)):
    """D24: undo the roster flip this withdrawal made.

    Restore the status the row replaced, but only while the player is still
    withdrawn and no other withdrawal for this tournament/player remains. A
    later roster edit therefore wins over a stale delete.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT tournament_id, player_id, prior_status FROM withdrawal WHERE id = %s",
            (withdrawal_id,),
        )
        w = cur.fetchone()
        if w is None:
            raise HTTPException(status_code=404, detail="withdrawal not found")
        cur.execute("DELETE FROM withdrawal WHERE id = %s", (withdrawal_id,))
        if w["prior_status"] is not None:
            cur.execute(
                "SELECT 1 FROM withdrawal WHERE tournament_id = %s AND player_id = %s LIMIT 1",
                (w["tournament_id"], w["player_id"]),
            )
            if cur.fetchone() is None:
                cur.execute(
                    "UPDATE tournament_entry SET selection_status = %s "
                    "WHERE tournament_id = %s AND player_id = %s "
                    "  AND selection_status = 'withdrawn'",
                    (w["prior_status"], w["tournament_id"], w["player_id"]),
                )
    return Response(status_code=204)
