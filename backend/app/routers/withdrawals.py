"""Withdrawals (Part B, audit §2.4). Reason required unless the player was an
alternate; recording flips the roster status to 'withdrawn' and (if filed from an
email) marks that email filed."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import WithdrawalCreate, WithdrawalOut, WithdrawalUpdate
from ..playerops import mark_email_filed, upsert_player

router = APIRouter(tags=["withdrawals"])

_SELECT = """
SELECT w.id, w.tournament_id, w.player_id, w.events, w.reason, w.notes,
       w.was_alternate, w.source_email_id,
       p.usta_number, p.first_name, p.last_name, te.age_division
FROM withdrawal w
JOIN player p ON p.id = w.player_id
LEFT JOIN tournament_entry te
       ON te.tournament_id = w.tournament_id AND te.player_id = w.player_id
"""


@router.get("/api/tournaments/{tournament_id}/withdrawals", response_model=list[WithdrawalOut])
def list_withdrawals(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_SELECT + " WHERE w.tournament_id = %s ORDER BY w.id", (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/withdrawals",
             response_model=WithdrawalOut, status_code=201)
def create_withdrawal(tournament_id: int, body: WithdrawalCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")

        # Audit M6: consolidated on the shared helper (refuses unknown players
        # without a gender; updates name on existing ones).
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name)

        # Was the player an alternate? (read before we flip the status)
        cur.execute(
            "SELECT selection_status FROM tournament_entry "
            "WHERE tournament_id = %s AND player_id = %s",
            (tournament_id, pid),
        )
        entry = cur.fetchone()
        was_alternate = bool(entry and entry["selection_status"] == "alternate")

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
                (tournament_id, player_id, events, reason, notes, was_alternate, source_email_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (tournament_id, pid, body.events, body.reason, body.notes,
             was_alternate, body.source_email_id),
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
    with conn.cursor() as cur:
        cur.execute("DELETE FROM withdrawal WHERE id = %s", (withdrawal_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="withdrawal not found")
    return Response(status_code=204)
