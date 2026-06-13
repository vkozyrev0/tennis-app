"""Payroll finalization (P4-4): lock computed pay at event close.

The live numbers (pay/mileage/total) always recompute from current rows —
which is right while the event runs, and wrong the moment the TD approves
payment: a later day edit, rate change, or no-show toggle would silently move
money that was already promised. Finalizing freezes one assignment's computed
summary into payroll_record; the grid then shows live vs finalized and flags
drift. Mark-paid tracks settlement (date/method/note). Unfinalize re-opens a
record — refused once paid (walk the payment back first).

Every lifecycle step lands in assignment_audit (finalized / unfinalized /
paid / unpaid), reusing the P4-5 trail.
"""
import json

from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import PayrollMarkPaid
from ..security import require_admin
from .assignments import _ASG_SELECT, _audit, _summary

router = APIRouter(tags=["payroll"])

_REC_COLS = (
    "r.id AS record_id, r.assignment_id, r.official_name, r.days_worked, r.no_show_days, "
    "r.pay, r.mileage, r.total, r.rule_version, r.finalized_at, r.finalized_by, "
    "r.paid, r.paid_at, r.paid_method, r.paid_note"
)


def _record_out(r: dict) -> dict:
    """Normalize a payroll_record row for JSON (Decimals → float, dates → iso)."""
    return {
        "record_id": r["record_id"],
        "days_worked": r["days_worked"],
        "no_show_days": r["no_show_days"],
        "pay": float(r["pay"]),
        "mileage": float(r["mileage"]) if r["mileage"] is not None else None,
        "total": float(r["total"]),
        "rule_version": r["rule_version"],
        "finalized_at": r["finalized_at"].isoformat(),
        "finalized_by": r["finalized_by"],
        "paid": r["paid"],
        "paid_at": r["paid_at"].isoformat() if r["paid_at"] else None,
        "paid_method": r["paid_method"],
        "paid_note": r["paid_note"],
    }


def _finalize_one(cur, a: dict, username: str) -> dict:
    """Freeze one assignment's computed summary. Caller checked no record exists."""
    s = _summary(cur, a)
    days_worked = len(s["days"]) - s["no_show_days"]
    cur.execute(
        "INSERT INTO payroll_record (assignment_id, tournament_id, official_id, "
        "  official_name, days_worked, no_show_days, pay, mileage, total, "
        "  rule_version, detail, finalized_by) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s) "
        "RETURNING id",
        (a["id"], a["tournament_id"], a["official_id"], s["official_name"],
         days_worked, s["no_show_days"], s["pay"], s["mileage"], s["total"],
         s.get("rule_version"), json.dumps({"days": s["days"]}), username),
    )
    rec_id = cur.fetchone()["id"]
    _audit(cur, a["id"], "finalized",
           {"record_id": rec_id, "total": s["total"]}, username)
    return {"record_id": rec_id, "assignment_id": a["id"],
            "official_name": s["official_name"], "total": s["total"]}


@router.get("/api/tournaments/{tournament_id}/payroll")
def payroll_summary(tournament_id: int, conn=Depends(db_dep)):
    """One row per assignment: live computed numbers + the finalized record (if
    any) + a drift flag when the two disagree. This is the summary-tab feed."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name",
                    (tournament_id,))
        assignments = cur.fetchall()
        cur.execute(f"SELECT {_REC_COLS} FROM payroll_record r "
                    "WHERE r.tournament_id = %s", (tournament_id,))
        # A deleted assignment leaves its record with assignment_id NULL (FK SET
        # NULL); UNIQUE permits many NULLs, so these CAN'T share a dict key —
        # keep them in a list, not the by-assignment map (which would collapse
        # every orphan onto the single None key and lose all but one).
        by_assignment, orphaned = {}, []
        for r in cur.fetchall():
            if r["assignment_id"] is None:
                orphaned.append(r)
            else:
                by_assignment[r["assignment_id"]] = r
        out = []
        for a in assignments:
            s = _summary(cur, a)
            rec = by_assignment.pop(a["id"], None)
            fin = _record_out(rec) if rec else None
            out.append({
                "assignment_id": a["id"],
                "official_id": a["official_id"],
                "official_name": s["official_name"],
                "days_worked": len(s["days"]) - s["no_show_days"],
                "no_show_days": s["no_show_days"],
                "pay": s["pay"], "mileage": s["mileage"], "total": s["total"],
                "missing_distance": s["missing_distance"],
                "finalized": fin,
                # money moved since finalization — re-finalize or investigate
                "drift": bool(fin) and fin["total"] != s["total"],
            })
        # Records whose assignment was deleted (FK NULL) — plus any defensive
        # leftovers — still owe/paid someone, so keep them visible. official_name
        # is denormalized on the record (no per-row re-query).
        for rec in orphaned + list(by_assignment.values()):
            out.append({
                "assignment_id": rec["assignment_id"],
                "official_id": None,
                "official_name": rec["official_name"],
                "days_worked": rec["days_worked"], "no_show_days": rec["no_show_days"],
                "pay": None, "mileage": None, "total": None,
                "missing_distance": False,
                "finalized": _record_out(rec), "drift": False,
                "orphaned": True,
            })
        return out


@router.post("/api/assignments/{assignment_id}/finalize", status_code=201)
def finalize_assignment(assignment_id: int, user=Depends(require_admin),
                        conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_ASG_SELECT + " WHERE a.id = %s", (assignment_id,))
        a = cur.fetchone()
        if a is None:
            raise HTTPException(status_code=404, detail="assignment not found")
        cur.execute("SELECT 1 FROM payroll_record WHERE assignment_id = %s",
                    (assignment_id,))
        if cur.fetchone() is not None:
            raise HTTPException(status_code=409,
                                detail="already finalized — unfinalize first to recompute")
        return _finalize_one(cur, a, user["username"])


@router.post("/api/tournaments/{tournament_id}/payroll/finalize-all")
def finalize_all(tournament_id: int, user=Depends(require_admin), conn=Depends(db_dep)):
    """Finalize every not-yet-finalized assignment. Already-finalized rows are
    skipped (idempotent — safe to re-run as stragglers get their days fixed)."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s "
                    "AND NOT EXISTS (SELECT 1 FROM payroll_record r "
                    "                WHERE r.assignment_id = a.id) "
                    "ORDER BY o.last_name", (tournament_id,))
        todo = cur.fetchall()
        done = [_finalize_one(cur, a, user["username"]) for a in todo]
        cur.execute("SELECT count(*) AS n FROM payroll_record WHERE tournament_id = %s",
                    (tournament_id,))
        return {"finalized": len(done), "records": done,
                "total_finalized": cur.fetchone()["n"]}


@router.delete("/api/payroll/{record_id}", status_code=204)
def unfinalize(record_id: int, user=Depends(require_admin), conn=Depends(db_dep)):
    """Re-open a finalized record so it can be recomputed. Refused once paid —
    walk the payment back (PUT paid=false) first, deliberately two steps."""
    with conn.cursor() as cur:
        cur.execute("SELECT assignment_id, paid, total FROM payroll_record WHERE id = %s",
                    (record_id,))
        rec = cur.fetchone()
        if rec is None:
            raise HTTPException(status_code=404, detail="payroll record not found")
        if rec["paid"]:
            raise HTTPException(status_code=409,
                                detail="record is marked paid — unmark it before unfinalizing")
        if rec["assignment_id"] is not None:
            _audit(cur, rec["assignment_id"], "unfinalized",
                   {"record_id": record_id, "total": float(rec["total"])},
                   user["username"])
        cur.execute("DELETE FROM payroll_record WHERE id = %s", (record_id,))
    return Response(status_code=204)


@router.put("/api/payroll/{record_id}/paid")
def mark_paid(record_id: int, body: PayrollMarkPaid, user=Depends(require_admin),
              conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT assignment_id FROM payroll_record WHERE id = %s", (record_id,))
        rec = cur.fetchone()
        if rec is None:
            raise HTTPException(status_code=404, detail="payroll record not found")
        cur.execute(
            "UPDATE payroll_record SET "
            "  paid = %(paid)s, "
            "  paid_at = CASE WHEN %(paid)s THEN COALESCE(%(paid_at)s, CURRENT_DATE) END, "
            "  paid_method = CASE WHEN %(paid)s THEN %(paid_method)s END, "
            "  paid_note = CASE WHEN %(paid)s THEN %(paid_note)s END "
            "WHERE id = %(id)s "
            f"RETURNING {_REC_COLS.replace('r.', '')}",
            {**body.model_dump(), "id": record_id},
        )
        row = cur.fetchone()
        if rec["assignment_id"] is not None:
            _audit(cur, rec["assignment_id"], "paid" if body.paid else "unpaid",
                   {"record_id": record_id, "method": body.paid_method}, user["username"])
        return _record_out(row)
