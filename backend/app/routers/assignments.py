"""Assignments (Tournament <-> Official) with per-day roles + pay/mileage.

Pay     = sum of each worked day's rate (the certification_rate in effect for the
          role worked that day, snapshotted as rate_applied) — audit §3.2.
Mileage = clamp((2 * one_way_miles - 50) * 0.65, 0, 100), using the official's
          distance to the assignment's site — audit §3.1 / §3.7. Null when no
          distance is on file (computation blocked, audit S4).
Hotel date mismatch is surfaced as a flag, not a hard block — audit §3.4.
Room-count IS a hard guard — an official can't be put in a full block (audit §3.4).
Pay/mileage/total are snapshotted on every change with the rule version, so a
figure is reproducible later even if rates/distances change — audit §5.3.

C2 (2026-07-21): shared helpers live in `app/assignment_ops.py`; bulk invite /
invite-text / coverage-fill live in `routers/assignments_bulk.py`. This module
keeps core CRUD + day edits + reports (declined/pending/conflicts/audit/pay).
Back-compat re-exports preserve imports from me/payroll/reports/dashboard/tests.
"""
import csv
import io
import json
import re

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..assignment_calc import (  # noqa: F401
    FREE_MILES,
    MILEAGE_CAP,
    MILEAGE_RATE,
    RULE_VERSION,
    compute_summary,
)
from ..assignment_ops import (  # noqa: F401 — re-export for me/payroll/reports/tests
    _ASG_SELECT,
    _audit,
    _check_assignment_refs,
    _check_room_capacity,
    _compose_invite,
    _insert_day,
    _persist_snapshot,
    _rate_for,
    _summaries,
    _summary,
    hard_conflict_counts,
    pay_summary,
)
from ..db import db_dep
from ..security import require_admin
from ..models import (
    AssignmentCreate,
    AssignmentDayCreate,
    AssignmentDayStatus,
)

router = APIRouter(tags=["assignments"])

@router.get("/api/officials/{official_id}/pay-summary")
def official_pay_summary(official_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        return pay_summary(cur, official_id)


@router.get("/api/officials/{official_id}/pay-statement")
def official_pay_statement(official_id: int, conn=Depends(db_dep)):
    """Reimbursement-grade pay statement for one official: every assignment with
    its per-day role + rate, the mileage calc (one-way miles → reimbursed), and a
    grand total. Richer than pay-summary (which is per-tournament totals only) —
    this is the day-level breakdown the official/TD needs for reimbursement."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT first_name, last_name, email, phone, city, state "
            "FROM official WHERE id = %s",
            (official_id,),
        )
        off = cur.fetchone()
        if off is None:
            raise HTTPException(status_code=404, detail="official not found")
        cur.execute(_ASG_SELECT + " WHERE a.official_id = %s ORDER BY t.play_start_date",
                    (official_id,))
        summaries = _summaries(cur, cur.fetchall())

    assignments = [{
        "tournament_id": s["tournament_id"], "tournament_name": s["tournament_name"],
        "site_label": s["site_label"],
        "days": [{"work_date": d["work_date"], "working_as": d["working_as"],
                  "rate_applied": d["rate_applied"],
                  "actual_status": d.get("actual_status", "planned")} for d in s["days"]],
        "pay": s["pay"], "mileage": s["mileage"], "one_way_miles": s["one_way_miles"],
        "missing_distance": s["missing_distance"], "total": s["total"],
        "response_status": s["response_status"],
    } for s in summaries]
    totals = {
        "pay": round(sum(a["pay"] for a in assignments), 2),
        "mileage": round(sum(a["mileage"] or 0.0 for a in assignments), 2),
        "total": round(sum(a["total"] for a in assignments), 2),
        "days": sum(len(a["days"]) for a in assignments),
        "assignments": len(assignments),
    }
    return {
        "official": {
            "id": official_id,
            "name": f'{off["last_name"]}, {off["first_name"]}',
            "email": off["email"], "phone": off["phone"],
            "location": ", ".join(x for x in (off["city"], off["state"]) if x),
        },
        "assignments": assignments,
        "totals": totals,
    }


@router.get("/api/officials/{official_id}/overview")
def official_overview(official_id: int, conn=Depends(db_dep)):
    """Official 360 — the top-bar search lands here: core identity, the certs they
    hold, and their season assignments + pay/mileage totals (reuses pay_summary)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, first_name, last_name, city, state FROM official WHERE id = %s",
            (official_id,),
        )
        off = cur.fetchone()
        if off is None:
            raise HTTPException(status_code=404, detail="official not found")
        cur.execute(
            "SELECT cert_type::text AS cert_type FROM certification "
            "WHERE official_id = %s ORDER BY cert_type::text",
            (official_id,),
        )
        certs = [r["cert_type"] for r in cur.fetchall()]
        pay = pay_summary(cur, official_id)
    return {"official": off, "certs": certs, "pay": pay}


@router.get("/api/tournaments/{tournament_id}/assignments")
def list_assignments(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name", (tournament_id,))
        rows = cur.fetchall()
        return _summaries(cur, rows)



@router.get("/api/tournaments/{tournament_id}/pay-statements")
def tournament_pay_statements(tournament_id: int, conn=Depends(db_dep)):
    """Batch reimbursement: a pay statement per official assigned to THIS
    tournament — each with their worked days (role + rate), the mileage calc, and
    a total — plus a tournament grand total. Feeds the one-click "all statements"
    PDF the TD hands to finance."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, play_start_date, play_end_date FROM tournament WHERE id = %s",
            (tournament_id,),
        )
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name, o.first_name",
                    (tournament_id,))
        summaries = _summaries(cur, cur.fetchall())

    officials = [{
        "assignment_id": s["id"], "official_name": s["official_name"],
        "official_email": s.get("official_email"),
        "days": [{"work_date": d["work_date"], "working_as": d["working_as"],
                  "rate_applied": d["rate_applied"],
                  "actual_status": d.get("actual_status", "planned")} for d in s["days"]],
        "pay": s["pay"], "mileage": s["mileage"], "one_way_miles": s["one_way_miles"],
        "missing_distance": s["missing_distance"], "total": s["total"],
        "response_status": s["response_status"],
    } for s in summaries]
    totals = {
        "pay": round(sum(o["pay"] for o in officials), 2),
        "mileage": round(sum(o["mileage"] or 0.0 for o in officials), 2),
        "total": round(sum(o["total"] for o in officials), 2),
        "days": sum(len(o["days"]) for o in officials),
        "officials": len(officials),
    }
    return {
        "tournament": {"id": t["id"], "name": t["name"],
                       "play_start_date": t["play_start_date"].isoformat(),
                       "play_end_date": t["play_end_date"].isoformat()},
        "officials": officials,
        "totals": totals,
    }


@router.get("/api/tournaments/{tournament_id}/declined")
def declined_assignments(tournament_id: int, conn=Depends(db_dep)):
    """Declined assignments needing re-staffing — the named, actionable list
    behind the dashboard alert (not just a count). Each carries the official, the
    slot they vacated (site + the days/roles they were going to work), and when
    they declined (most-recent first), so the TD knows exactly who to replace."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT a.id, a.responded_at, a.site_id, "
            "       o.first_name, o.last_name, "
            "       COALESCE(s.code, s.name) AS site_label "
            "FROM assignment a "
            "JOIN official o ON o.id = a.official_id "
            "LEFT JOIN site s ON s.id = a.site_id "
            "WHERE a.tournament_id = %s AND a.response_status = 'declined' "
            "ORDER BY a.responded_at DESC NULLS LAST, o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()
        out = []
        for r in rows:
            cur.execute(
                "SELECT work_date, working_as FROM assignment_day "
                "WHERE assignment_id = %s ORDER BY work_date",
                (r["id"],),
            )
            days = [{"work_date": dd["work_date"].isoformat(), "working_as": dd["working_as"]}
                    for dd in cur.fetchall()]
            out.append({
                "assignment_id": r["id"],
                "official_name": f'{r["last_name"]}, {r["first_name"]}',
                "site_id": r["site_id"], "site_label": r["site_label"],
                "responded_at": r["responded_at"].isoformat() if r["responded_at"] else None,
                "days": days, "day_count": len(days),
            })
    return {"tournament_id": tournament_id, "declined": out, "count": len(out)}


@router.get("/api/tournaments/{tournament_id}/pending")
def pending_assignments(tournament_id: int, conn=Depends(db_dep)):
    """Officials who haven't accepted/declined yet — the named, actionable list
    behind the dashboard's 'N awaiting response'. Each carries the official's
    email (for a mailto nudge) and the slot they'd work, so the TD can chase them
    one by one. Oldest assignment first (longest-waiting nudged soonest)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT a.id, a.snapshot_at, a.last_nudged_at, o.first_name, o.last_name, o.email "
            "FROM assignment a "
            "JOIN official o ON o.id = a.official_id "
            "WHERE a.tournament_id = %s AND a.response_status = 'pending' "
            "ORDER BY a.snapshot_at ASC NULLS LAST, o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()
        out = []
        for r in rows:
            cur.execute(
                "SELECT work_date, working_as FROM assignment_day "
                "WHERE assignment_id = %s ORDER BY work_date",
                (r["id"],),
            )
            days = [{"work_date": dd["work_date"].isoformat(), "working_as": dd["working_as"]}
                    for dd in cur.fetchall()]
            out.append({
                "assignment_id": r["id"],
                "official_name": f'{r["last_name"]}, {r["first_name"]}',
                "first_name": r["first_name"],
                "official_email": r["email"],
                "last_nudged_at": r["last_nudged_at"].isoformat() if r["last_nudged_at"] else None,
                "day_count": len(days), "days": days,
            })
    return {"tournament_id": tournament_id, "pending": out, "count": len(out)}


@router.post("/api/assignments/{assignment_id}/nudged")
def mark_nudged(assignment_id: int, user=Depends(require_admin), conn=Depends(db_dep)):
    """Record that the TD just chased this official (outreach memory) — the
    pending list then shows 'nudged Nd ago' so a fresh gap reads differently from
    a chased-but-silent one. Idempotent; only the timestamp moves."""
    with conn.cursor() as cur:
        cur.execute("UPDATE assignment SET last_nudged_at = now() WHERE id = %s "
                    "RETURNING last_nudged_at", (assignment_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="assignment not found")
    return {"assignment_id": assignment_id, "last_nudged_at": row["last_nudged_at"].isoformat()}


@router.post("/api/tournaments/{tournament_id}/pending/nudged")
def mark_all_pending_nudged(tournament_id: int, user=Depends(require_admin), conn=Depends(db_dep)):
    """Bulk outreach mark for the 'Nudge all' action — stamps every still-pending
    assignment in the tournament. Returns how many were marked."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute("UPDATE assignment SET last_nudged_at = now() "
                    "WHERE tournament_id = %s AND response_status = 'pending'", (tournament_id,))
        return {"tournament_id": tournament_id, "marked": cur.rowcount}


@router.get("/api/tournaments/{tournament_id}/conflicts")
def assignment_conflicts(tournament_id: int, conn=Depends(db_dep)):
    """All staffing conflicts for a tournament in one place, so the TD can resolve
    them before the event. Aggregates the per-assignment flags already computed by
    _summary: cross-tournament double-bookings (hard = a different site same day),
    uncertified worked days, days worked outside a declared-available window, days
    outside the play window, and hotel-date mismatches."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name", (tournament_id,))
        summaries = _summaries(cur, cur.fetchall())

    double_bookings, uncertified, outside_avail, out_of_window, hotel_mismatch = [], [], [], [], []
    for s in summaries:
        who = {"assignment_id": s["id"], "official_id": s["official_id"],
               "official_name": s["official_name"]}
        for c in s["conflicts"]:
            double_bookings.append({**who, "work_date": c["work_date"],
                                    "other_tournament_id": c["other_tournament_id"],
                                    "other_tournament": c["other_tournament"],
                                    "other_site": c["other_site"],
                                    "different_site": c["different_site"]})
        for u in s["uncertified_days"]:
            uncertified.append({**who, "work_date": u["work_date"], "working_as": u["working_as"]})
        for d in s["days_outside_availability"]:
            outside_avail.append({**who, "work_date": d})
        if s["work_date_out_of_window"]:
            out_of_window.append({**who})
        if s["hotel_date_mismatch"]:
            hotel_mismatch.append({**who})

    hard = sum(1 for d in double_bookings if d["different_site"])
    counts = {"double_bookings": len(double_bookings), "hard_double_bookings": hard,
              "uncertified": len(uncertified), "outside_availability": len(outside_avail),
              "out_of_window": len(out_of_window), "hotel_mismatch": len(hotel_mismatch)}
    counts["total"] = (len(double_bookings) + len(uncertified) + len(outside_avail)
                       + len(out_of_window) + len(hotel_mismatch))
    return {"tournament_id": tournament_id, "counts": counts,
            "double_bookings": double_bookings, "uncertified": uncertified,
            "outside_availability": outside_avail, "out_of_window": out_of_window,
            "hotel_mismatch": hotel_mismatch}


@router.get("/api/assignments/{assignment_id}/audit")
def assignment_audit_trail(assignment_id: int, conn=Depends(db_dep)):
    """The change history for one assignment, newest first. (Rows for DELETED
    assignments keep their denormalized identity and remain queryable by
    tournament_id directly in the table.)"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, changed_at, changed_by, action, detail "
            "FROM assignment_audit WHERE assignment_id = %s ORDER BY changed_at DESC, id DESC",
            (assignment_id,),
        )
        return cur.fetchall()


_AUDIT_CSV_HEADERS = ["When", "Official", "Action", "Detail", "By"]


@router.get("/api/tournaments/{tournament_id}/assignment-audit.csv")
def assignment_audit_csv(tournament_id: int, user=Depends(require_admin),
                         conn=Depends(db_dep)):
    """The whole assignment audit trail for a tournament as a CSV — the
    dispute-resolution record (who changed what, when) the bookkeeper or a
    grievance review can keep. Chronological (oldest first) so it reads as a
    timeline. utf-8-sig so Excel reads the encoding. Includes rows whose
    assignment was later deleted (identity is denormalized on the trail)."""
    from ..export_audit import log_export
    with conn.cursor() as cur:
        cur.execute("SELECT name FROM tournament WHERE id = %s", (tournament_id,))
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT changed_at, official_name, action, detail, changed_by "
            "FROM assignment_audit WHERE tournament_id = %s "
            "ORDER BY changed_at ASC, id ASC",
            (tournament_id,),
        )
        rows = cur.fetchall()
        log_export(
            cur, username=user["username"], resource="assignment_audit",
            tournament_id=tournament_id, client_kind="api",
            detail={"row_count": len(rows)},
        )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(_AUDIT_CSV_HEADERS)
    for r in rows:
        # detail is a small jsonb object; compact-json it so the CSV stays one
        # cell per row (empty when null).
        detail = json.dumps(r["detail"], separators=(",", ":")) if r["detail"] else ""
        w.writerow([
            r["changed_at"].isoformat(timespec="minutes"),
            r["official_name"] or "", r["action"], detail, r["changed_by"],
        ])
    body = buf.getvalue().encode("utf-8-sig")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", t["name"]).strip("-") or "tournament"
    return Response(content=body, media_type="text/csv",
                    headers={"Content-Disposition":
                             f'attachment; filename="assignment-audit-{slug}.csv"'})

@router.post("/api/tournaments/{tournament_id}/assignments", status_code=201)
def create_assignment(tournament_id: int, body: AssignmentCreate,
                      user=Depends(require_admin), conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            _check_assignment_refs(cur, tournament_id, body.site_id, body.room_block_id)
            _check_room_capacity(cur, body.room_block_id)
            cur.execute(
                """
                INSERT INTO assignment (tournament_id, official_id, site_id, room_block_id)
                VALUES (%s, %s, %s, %s) RETURNING id
                """,
                (tournament_id, body.official_id, body.site_id, body.room_block_id),
            )
            new_id = cur.fetchone()["id"]
            _audit(cur, new_id, "created",
                   {"site_id": body.site_id, "room_block_id": body.room_block_id},
                   user["username"])
            return _persist_snapshot(cur, new_id)
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="official already assigned to this tournament")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id, site_id, or room_block_id invalid")

@router.put("/api/assignments/{assignment_id}")
def update_assignment(assignment_id: int, body: AssignmentCreate,
                      user=Depends(require_admin), conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tournament_id FROM assignment WHERE id = %s",
                (assignment_id,),
            )
            existing = cur.fetchone()
            if existing is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            _check_assignment_refs(
                cur, existing["tournament_id"], body.site_id, body.room_block_id,
            )
            _check_room_capacity(cur, body.room_block_id, exclude_id=assignment_id)
            cur.execute(
                "UPDATE assignment SET official_id=%s, site_id=%s, room_block_id=%s "
                "WHERE id=%s RETURNING id",
                (body.official_id, body.site_id, body.room_block_id, assignment_id),
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            _audit(cur, assignment_id, "updated",
                   {"official_id": body.official_id, "site_id": body.site_id,
                    "room_block_id": body.room_block_id}, user["username"])
            return _persist_snapshot(cur, assignment_id)
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="official already assigned to this tournament")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id, site_id, or room_block_id invalid")


@router.delete("/api/assignments/{assignment_id}", status_code=204)
def delete_assignment(assignment_id: int, user=Depends(require_admin), conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _audit(cur, assignment_id, "deleted", None, user["username"])
        cur.execute("DELETE FROM assignment WHERE id = %s", (assignment_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="assignment not found")
    return Response(status_code=204)

@router.post("/api/assignments/{assignment_id}/days", status_code=201)
def add_day(assignment_id: int, body: AssignmentDayCreate,
            user=Depends(require_admin), conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT official_id FROM assignment WHERE id = %s", (assignment_id,))
        asg = cur.fetchone()
        if asg is None:
            raise HTTPException(status_code=404, detail="assignment not found")
        _insert_day(cur, assignment_id, asg["official_id"], body.work_date, body.working_as)
        _audit(cur, assignment_id, "day_added",
               {"work_date": str(body.work_date), "working_as": body.working_as},
               user["username"])
        return _persist_snapshot(cur, assignment_id)


@router.put("/api/assignment-days/{day_id}/status")
def set_day_status(day_id: int, body: AssignmentDayStatus,
                   user=Depends(require_admin), conn=Depends(db_dep)):
    """Day-of truth (P4-1): record what actually happened on one worked day.
    no_show days drop out of pay, so the snapshot is refrozen; the response is
    the fresh assignment summary the card re-renders from."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE assignment_day SET actual_status = %s WHERE id = %s "
            "RETURNING assignment_id, work_date",
            (body.actual_status, day_id),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="assignment day not found")
        _audit(cur, row["assignment_id"], "day_status",
               {"work_date": str(row["work_date"]), "actual_status": body.actual_status},
               user["username"])
        return _persist_snapshot(cur, row["assignment_id"])


@router.delete("/api/assignment-days/{day_id}", status_code=204)
def delete_day(day_id: int, user=Depends(require_admin), conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT assignment_id, work_date FROM assignment_day WHERE id = %s", (day_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="assignment day not found")
        assignment_id = row["assignment_id"]
        cur.execute("DELETE FROM assignment_day WHERE id = %s", (day_id,))
        _audit(cur, assignment_id, "day_removed",
               {"work_date": str(row["work_date"])}, user["username"])
        _persist_snapshot(cur, assignment_id)
    return Response(status_code=204)
