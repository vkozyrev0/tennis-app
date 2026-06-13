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
import csv
import io
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import PayrollMarkPaid, PaymentBatchCreate
from ..security import require_admin
from .assignments import _ASG_SELECT, _audit, _summary

router = APIRouter(tags=["payroll"])

_REC_COLS = (
    "r.id AS record_id, r.assignment_id, r.official_name, r.days_worked, r.no_show_days, "
    "r.pay, r.mileage, r.total, r.rule_version, r.finalized_at, r.finalized_by, "
    "r.paid, r.paid_at, r.paid_method, r.paid_note, r.batch_id"
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
        "batch_id": r["batch_id"],
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


_CSV_HEADERS = ["Official", "Days worked", "No-show days", "Pay", "Mileage",
                "Total", "Rule version", "Finalized at", "Finalized by",
                "Paid", "Paid date", "Method", "Note"]


@router.get("/api/tournaments/{tournament_id}/payroll/export.csv")
def payroll_export_csv(tournament_id: int, conn=Depends(db_dep)):
    """The finalized records as a CSV for the bookkeeper. Only FINALIZED rows
    (frozen amounts) — live/unfinalized numbers aren't payable yet. utf-8-sig so
    Excel reads the encoding; amounts as plain 2dp strings (not locale money)."""
    with conn.cursor() as cur:
        cur.execute("SELECT name FROM tournament WHERE id = %s", (tournament_id,))
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(f"SELECT {_REC_COLS} FROM payroll_record r "
                    "WHERE r.tournament_id = %s ORDER BY r.official_name", (tournament_id,))
        recs = cur.fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(_CSV_HEADERS)
    money = lambda v: "" if v is None else f"{float(v):.2f}"
    for r in recs:
        w.writerow([
            r["official_name"], r["days_worked"], r["no_show_days"],
            money(r["pay"]), money(r["mileage"]), money(r["total"]),
            r["rule_version"] or "",
            r["finalized_at"].isoformat(timespec="minutes"), r["finalized_by"],
            "yes" if r["paid"] else "no",
            r["paid_at"].isoformat() if r["paid_at"] else "",
            r["paid_method"] or "", r["paid_note"] or "",
        ])
    body = buf.getvalue().encode("utf-8-sig")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", t["name"]).strip("-") or "tournament"
    return Response(content=body, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="payroll-{slug}.csv"'})


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


# ---- Payment batches -------------------------------------------------------
# A batch settles a group of finalized records at once (a check run, an ACH
# file). Creating one marks every member paid with the shared method/date;
# dissolving it walks every member back to unpaid. See migration 0048.

def _batch_out(b: dict) -> dict:
    """Normalize a payment_batch + aggregates row for JSON."""
    return {
        "batch_id": b["id"],
        "reference": b["reference"],
        "method": b["method"],
        "paid_on": b["paid_on"].isoformat(),
        "note": b["note"],
        "created_by": b["created_by"],
        "created_at": b["created_at"].isoformat(),
        "record_count": b["record_count"],
        "total": float(b["total"]),
    }


@router.get("/api/tournaments/{tournament_id}/payroll/batches")
def list_batches(tournament_id: int, conn=Depends(db_dep)):
    """Payment batches for the tournament, newest first, with member count and
    summed total (LEFT JOIN so a batch whose records were unfinalized still
    lists, at count 0)."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT b.id, b.reference, b.method, b.paid_on, b.note, b.created_by, "
            "       b.created_at, count(r.id) AS record_count, "
            "       COALESCE(sum(r.total), 0) AS total "
            "FROM payment_batch b "
            "LEFT JOIN payroll_record r ON r.batch_id = b.id "
            "WHERE b.tournament_id = %s "
            "GROUP BY b.id ORDER BY b.created_at DESC, b.id DESC",
            (tournament_id,),
        )
        return [_batch_out(b) for b in cur.fetchall()]


@router.get("/api/payroll/batches/{batch_id}")
def get_batch(batch_id: int, conn=Depends(db_dep)):
    """One batch with its member records — the feed for the printable receipt
    the TD files with the checks. members carry the frozen per-official total."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tournament_id, reference, method, paid_on, note, created_by, "
            "       created_at FROM payment_batch WHERE id = %s", (batch_id,))
        b = cur.fetchone()
        if b is None:
            raise HTTPException(status_code=404, detail="payment batch not found")
        cur.execute(
            "SELECT official_name, days_worked, total, paid_at "
            "FROM payroll_record WHERE batch_id = %s ORDER BY official_name", (batch_id,))
        members = cur.fetchall()
    return {
        "batch_id": b["id"], "tournament_id": b["tournament_id"],
        "reference": b["reference"], "method": b["method"],
        "paid_on": b["paid_on"].isoformat(), "note": b["note"],
        "created_by": b["created_by"], "created_at": b["created_at"].isoformat(),
        "record_count": len(members),
        "total": sum(float(m["total"]) for m in members),
        "members": [{
            "official_name": m["official_name"], "days_worked": m["days_worked"],
            "total": float(m["total"]),
            "paid_at": m["paid_at"].isoformat() if m["paid_at"] else None,
        } for m in members],
    }


@router.post("/api/tournaments/{tournament_id}/payroll/batches", status_code=201)
def create_batch(tournament_id: int, body: PaymentBatchCreate,
                 user=Depends(require_admin), conn=Depends(db_dep)):
    """Create a batch and mark its member records paid. Every record_id must be
    a finalized record in THIS tournament that is not already paid or batched —
    otherwise the whole call is refused (409), so a batch is all-or-nothing."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        # de-dupe ids; fetch the candidate records and validate as a set
        ids = list(dict.fromkeys(body.record_ids))
        cur.execute(
            "SELECT id, assignment_id, tournament_id, paid, batch_id "
            "FROM payroll_record WHERE id = ANY(%s)", (ids,))
        found = {r["id"]: r for r in cur.fetchall()}
        missing = [i for i in ids if i not in found]
        if missing:
            raise HTTPException(status_code=404,
                                detail=f"payroll record(s) not found: {missing}")
        wrong_t = [i for i, r in found.items() if r["tournament_id"] != tournament_id]
        if wrong_t:
            raise HTTPException(status_code=409,
                                detail=f"record(s) not in this tournament: {wrong_t}")
        already = [i for i, r in found.items() if r["paid"] or r["batch_id"] is not None]
        if already:
            raise HTTPException(status_code=409,
                                detail=f"record(s) already paid or batched: {already}")
        cur.execute(
            "INSERT INTO payment_batch (tournament_id, reference, method, paid_on, note, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id, created_at",
            (tournament_id, body.reference, body.method, body.paid_on, body.note,
             user["username"]),
        )
        batch = cur.fetchone()
        cur.execute(
            "UPDATE payroll_record SET paid = true, paid_at = %s, paid_method = %s, "
            "  paid_note = COALESCE(%s, paid_note), batch_id = %s "
            "WHERE id = ANY(%s) RETURNING total",
            (body.paid_on, body.method, body.note, batch["id"], ids),
        )
        total = sum(float(r["total"]) for r in cur.fetchall())
        for i in ids:
            aid = found[i]["assignment_id"]
            if aid is not None:
                _audit(cur, aid, "paid",
                       {"record_id": i, "batch_id": batch["id"], "method": body.method},
                       user["username"])
        return {
            "batch_id": batch["id"], "reference": body.reference, "method": body.method,
            "paid_on": body.paid_on.isoformat(), "note": body.note,
            "created_by": user["username"], "created_at": batch["created_at"].isoformat(),
            "record_count": len(ids), "total": total,
        }


@router.delete("/api/payroll/batches/{batch_id}", status_code=204)
def dissolve_batch(batch_id: int, user=Depends(require_admin), conn=Depends(db_dep)):
    """Dissolve a batch: walk every member record back to unpaid and remove the
    batch. The records themselves stay finalized — only the settlement is undone
    (mirrors PUT paid=false). Each member lands an 'unpaid' audit entry."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM payment_batch WHERE id = %s", (batch_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="payment batch not found")
        cur.execute("SELECT id, assignment_id FROM payroll_record WHERE batch_id = %s",
                    (batch_id,))
        members = cur.fetchall()
        cur.execute(
            "UPDATE payroll_record SET paid = false, paid_at = NULL, paid_method = NULL, "
            "  paid_note = NULL, batch_id = NULL WHERE batch_id = %s", (batch_id,))
        for m in members:
            if m["assignment_id"] is not None:
                _audit(cur, m["assignment_id"], "unpaid",
                       {"record_id": m["id"], "batch_id": batch_id}, user["username"])
        cur.execute("DELETE FROM payment_batch WHERE id = %s", (batch_id,))
    return Response(status_code=204)
