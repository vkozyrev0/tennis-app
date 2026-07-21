"""Bulk invite, invite-text, and coverage-fill routes (C2 from assignments.py).

Paths unchanged. Mounted next to the main assignments router in main.py.
"""
import psycopg
from fastapi import APIRouter, Depends, HTTPException

from ..assignment_ops import (
    _ASG_SELECT,
    _audit,
    _check_assignment_refs,
    _check_room_capacity,
    _compose_invite,
    _insert_day,
    _persist_snapshot,
    _summaries,
    _summary,
)
from ..bulk_ops import savepoint
from ..db import db_dep
from ..models import AssignmentBulkCreate, CoverageFillCreate
from ..security import require_admin

router = APIRouter(tags=["assignments"])

@router.post("/api/tournaments/{tournament_id}/assignments/bulk", status_code=201)
def bulk_create_assignments(tournament_id: int, body: AssignmentBulkCreate,
                            user=Depends(require_admin), conn=Depends(db_dep)):
    """Invite several officials at once — one pending assignment each. Officials
    already on this tournament are skipped (not an error), so the TD can re-run
    the action as the pool grows. Returns the created assignments plus the
    skipped/invalid ids, and the contact list for the new invites (so the UI can
    open a single mailto to everyone who was just invited)."""
    ids = list(dict.fromkeys(body.official_ids))  # de-dupe, preserve order
    if not ids:
        raise HTTPException(status_code=400, detail="official_ids is required")
    created, skipped_existing, invalid = [], [], []
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        # Fail the whole bulk call on a bad site/hotel (not a per-official
        # skip) — every row would share the same bad refs.
        _check_assignment_refs(cur, tournament_id, body.site_id, body.room_block_id)
        _check_room_capacity(cur, body.room_block_id)
        # Which of these officials exist, and which are already assigned here?
        cur.execute("SELECT id FROM official WHERE id = ANY(%s)", (ids,))
        existing_ids = {r["id"] for r in cur.fetchall()}
        cur.execute(
            "SELECT official_id FROM assignment WHERE tournament_id = %s "
            "AND official_id = ANY(%s)",
            (tournament_id, ids),
        )
        already = {r["official_id"] for r in cur.fetchall()}
        for oid in ids:
            if oid not in existing_ids:
                invalid.append(oid)
                continue
            if oid in already:
                skipped_existing.append(oid)
                continue
            # Room capacity is re-checked per insert so a small block can't be
            # over-filled by a single bulk call.
            try:
                _check_room_capacity(cur, body.room_block_id)
            except HTTPException:
                skipped_existing.append(oid)  # no room left → leave for later
                continue
            # Per-official SAVEPOINT (P2 #10): a concurrent invite landing
            # between the `already` pre-check and this INSERT hits the UNIQUE
            # and would otherwise abort the WHOLE batch — skip just that one.
            try:
                with savepoint(cur):
                    cur.execute(
                        "INSERT INTO assignment (tournament_id, official_id, site_id, room_block_id) "
                        "VALUES (%s, %s, %s, %s) RETURNING id",
                        (tournament_id, oid, body.site_id, body.room_block_id),
                    )
                    _bid = cur.fetchone()["id"]
                    _audit(cur, _bid, "created", {"via": "bulk-invite"}, user["username"])
                    created.append(_persist_snapshot(cur, _bid))
            except psycopg.errors.UniqueViolation:
                skipped_existing.append(oid)
    return {
        "created": created,
        "created_count": len(created),
        "skipped_existing": skipped_existing,
        "invalid": invalid,
        # Emails of the freshly-invited officials who have one on file — the UI
        # turns this into a single mailto: to "send" the response request.
        "invite_emails": [c["official_email"] for c in created if c.get("official_email")],
    }

@router.get("/api/assignments/{assignment_id}/invite-text")
def assignment_invite_text(assignment_id: int, conn=Depends(db_dep)):
    """A ready-to-paste assignment email personalised to this official: their
    specific worked days + roles, the site, and the estimated pay/mileage. Beyond
    the generic bulk mailto — the TD copies it or opens a pre-filled email."""
    with conn.cursor() as cur:
        cur.execute(_ASG_SELECT + " WHERE a.id = %s", (assignment_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="assignment not found")
        s = _summary(cur, row)
        composed = _compose_invite(s, row["first_name"] or "official")
    return {
        "assignment_id": assignment_id,
        "official_name": s["official_name"],
        "official_email": s.get("official_email"),
        **composed,
    }


@router.get("/api/tournaments/{tournament_id}/invite-texts")
def tournament_invite_texts(tournament_id: int, conn=Depends(db_dep)):
    """A personalised invite for every official assigned to this tournament — the
    TD generates them all at once, copies the combined document, or BCCs everyone
    who has an email on file. Each carries the same per-official detail as the
    single invite."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name, o.first_name",
                    (tournament_id,))
        rows = cur.fetchall()
        # D10: batch summaries (5 set-based queries) instead of 5×N.
        summaries = _summaries(cur, rows)
        invites = []
        for row, s in zip(rows, summaries):
            composed = _compose_invite(s, row["first_name"] or "official")
            invites.append({
                "assignment_id": s["id"], "official_name": s["official_name"],
                "official_email": s.get("official_email"), **composed,
            })
    emails = [i["official_email"] for i in invites if i["official_email"]]
    return {"invites": invites, "count": len(invites), "emails": emails}

@router.get("/api/tournaments/{tournament_id}/coverage-candidates")
def coverage_candidates(tournament_id: int, role: str, date: str, conn=Depends(db_dep)):
    """Who could fill an uncovered (role, date) cell on the coverage report —
    officials CERTIFIED for `role` who aren't already working `date` in this
    tournament. Each carries flags so the UI can rank them: `available` (declared
    available that day), `assigned_here` (already on this tournament — fill just
    adds a day, no new invite), and `busy_elsewhere` (working that date in another
    tournament — a soft double-book warning). Best candidates sort first."""
    from datetime import date as _date
    try:
        _date.fromisoformat(date)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="date must be ISO format (YYYY-MM-DD)")
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.id, o.last_name, o.first_name,
                   EXISTS (SELECT 1 FROM assignment a
                           WHERE a.tournament_id = %(tid)s AND a.official_id = o.id)
                       AS assigned_here,
                   EXISTS (SELECT 1 FROM availability av
                           WHERE av.official_id = o.id AND av.tournament_id = %(tid)s
                             AND av.available_date = %(d)s) AS available,
                   EXISTS (SELECT 1 FROM assignment a
                           JOIN assignment_day ad ON ad.assignment_id = a.id
                           WHERE a.official_id = o.id AND ad.work_date = %(d)s
                             AND a.tournament_id <> %(tid)s) AS busy_elsewhere
            FROM official o
            JOIN certification c
              ON c.official_id = o.id AND c.cert_type::text = %(role)s
            WHERE NOT EXISTS (
                SELECT 1 FROM assignment a
                JOIN assignment_day ad ON ad.assignment_id = a.id
                WHERE a.tournament_id = %(tid)s AND a.official_id = o.id
                  AND ad.work_date = %(d)s
            )
            ORDER BY available DESC, busy_elsewhere ASC, o.last_name, o.first_name
            """,
            {"tid": tournament_id, "role": role, "d": date},
        )
        rows = cur.fetchall()
    return [
        {"official_id": r["id"], "official_name": f'{r["last_name"]}, {r["first_name"]}',
         "available": r["available"], "assigned_here": r["assigned_here"],
         "busy_elsewhere": r["busy_elsewhere"]}
        for r in rows
    ]


@router.post("/api/tournaments/{tournament_id}/coverage-fill", status_code=201)
def coverage_fill(tournament_id: int, body: CoverageFillCreate,
                  user=Depends(require_admin), conn=Depends(db_dep)):
    """Fill a coverage gap in one click: ensure the official has an assignment on
    this tournament (create a pending one if needed), then add the (date, role)
    day. Reuses the cert guard + pay snapshot. 409 if they already work that day."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM assignment WHERE tournament_id = %s AND official_id = %s",
                (tournament_id, body.official_id),
            )
            row = cur.fetchone()
            if row is not None:
                aid = row["id"]
            else:
                cur.execute(
                    "INSERT INTO assignment (tournament_id, official_id) VALUES (%s, %s) RETURNING id",
                    (tournament_id, body.official_id),
                )
                aid = cur.fetchone()["id"]
                _audit(cur, aid, "created", {"via": "coverage-fill"}, user["username"])
            _insert_day(cur, aid, body.official_id, body.work_date, body.working_as)
            _audit(cur, aid, "day_added",
                   {"work_date": str(body.work_date), "working_as": body.working_as,
                    "via": "coverage-fill"}, user["username"])
            return _persist_snapshot(cur, aid)
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="tournament_id or official_id invalid")
