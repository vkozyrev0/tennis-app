"""TD "Today" dashboard — a lightweight at-a-glance aggregate for one tournament.

Rolls up the numbers that otherwise live behind the Inbox, Assignments, Roster
and Reports tabs (unfiled emails, official responses, coverage gaps, roster
status, room pickup) into a single cheap call, so the TD opens the app to a
status board instead of an empty catalog. Uses COUNT/GROUP-BY queries — it does
NOT build the full per-official report.
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep

router = APIRouter(prefix="/api/tournaments", tags=["dashboard"])


@router.get("/{tournament_id}/dashboard")
def dashboard(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, type, play_start_date, play_end_date, "
            "       registration_deadline, late_entry_deadline "
            "FROM tournament WHERE id = %s",
            (tournament_id,),
        )
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        start, end = t["play_start_date"], t["play_end_date"]
        t["play_start_date"] = start.isoformat()
        t["play_end_date"] = end.isoformat()
        for k in ("registration_deadline", "late_entry_deadline"):
            t[k] = t[k].isoformat() if t[k] else None

        # Inbox: how many emails are still unfiled (new) vs filed / follow-up.
        cur.execute(
            "SELECT status, count(*) AS n FROM email_message WHERE tournament_id = %s GROUP BY status",
            (tournament_id,),
        )
        ib = {r["status"]: r["n"] for r in cur.fetchall()}
        inbox = {"new": ib.get("new", 0), "filed": ib.get("filed", 0),
                 "needs_followup": ib.get("needs_followup", 0)}

        # Roster status mix.
        cur.execute(
            "SELECT selection_status, count(*) AS n FROM tournament_entry "
            "WHERE tournament_id = %s GROUP BY selection_status",
            (tournament_id,),
        )
        rs = {r["selection_status"]: r["n"] for r in cur.fetchall()}
        roster = {"selected": rs.get("selected", 0), "alternate": rs.get("alternate", 0),
                  "withdrawn": rs.get("withdrawn", 0),
                  "total": sum(rs.values())}

        # Officials: assignment response mix (accept/decline/pending).
        cur.execute(
            "SELECT response_status, count(*) AS n FROM assignment "
            "WHERE tournament_id = %s GROUP BY response_status",
            (tournament_id,),
        )
        os_ = {r["response_status"]: r["n"] for r in cur.fetchall()}
        officials = {"total": sum(os_.values()), "pending": os_.get("pending", 0),
                     "accepted": os_.get("accepted", 0), "declined": os_.get("declined", 0)}

        # Coverage gaps: play-window days with no official assigned at all.
        cur.execute(
            "SELECT DISTINCT ad.work_date FROM assignment_day ad "
            "JOIN assignment a ON a.id = ad.assignment_id WHERE a.tournament_id = %s",
            (tournament_id,),
        )
        worked = {r["work_date"] for r in cur.fetchall()}
        uncovered, cur_day = [], start
        while cur_day <= end:
            if cur_day not in worked:
                uncovered.append(cur_day.isoformat())
            cur_day += timedelta(days=1)

        # Official room-block pickup: reserved vs assigned (declined frees a room).
        cur.execute(
            "SELECT COALESCE(sum(rb.room_count), 0) AS reserved, "
            "       COALESCE(sum((SELECT count(*) FROM assignment a "
            "                     WHERE a.room_block_id = rb.id "
            "                     AND a.response_status <> 'declined')), 0) AS assigned "
            "FROM room_block rb WHERE rb.tournament_id = %s AND rb.kind = 'official'",
            (tournament_id,),
        )
        rb = cur.fetchone()
        reserved, assigned = int(rb["reserved"]), int(rb["assigned"])

    return {
        "tournament": t,
        "inbox": inbox,
        "roster": roster,
        "officials": officials,
        "coverage": {"uncovered_days": uncovered, "uncovered_days_count": len(uncovered)},
        "rooms": {"reserved": reserved, "assigned": assigned,
                  "unused": max(reserved - assigned, 0)},
    }
