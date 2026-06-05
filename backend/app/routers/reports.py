"""Tournament reports — officials confirmation roster + pay/mileage totals.

Reuses the assignment summary (per-day roles, computed pay/mileage, hotel
date-mismatch flag) and adds the official's dietary restrictions (audit §2.3) and
tournament-level totals. This is the Phase 1 "print both reports" deliverable.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from .assignments import _ASG_SELECT, _summary

router = APIRouter(prefix="/api/tournaments", tags=["reports"])


@router.get("/{tournament_id}/reports/officials")
def officials_report(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, type, play_start_date, play_end_date "
            "FROM tournament WHERE id = %s",
            (tournament_id,),
        )
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        t["play_start_date"] = t["play_start_date"].isoformat()
        t["play_end_date"] = t["play_end_date"].isoformat()

        cur.execute(
            _ASG_SELECT
            + " WHERE a.tournament_id = %s ORDER BY o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()

        # _summary already carries dietary_restrictions (joined in _ASG_SELECT),
        # so no per-official follow-up query is needed.
        officials = [_summary(cur, a) for a in rows]

        # Non-official support staff round out the TD's staffing plan — listed
        # separately (no pay/mileage/days), grouped by role in the report.
        cur.execute(
            "SELECT s.id, s.name, s.role, s.phone, s.email, s.notes, s.daily_rate, "
            "       COALESCE(array_agg(d.work_date ORDER BY d.work_date) "
            "                FILTER (WHERE d.work_date IS NOT NULL), '{}') AS days "
            "FROM tournament_staff s LEFT JOIN staff_day d ON d.staff_id = s.id "
            "WHERE s.tournament_id = %s GROUP BY s.id ORDER BY s.role, s.name",
            (tournament_id,),
        )
        staff = cur.fetchall()
        for s in staff:
            s["days"] = [d.isoformat() for d in s["days"]]
            # Flat daily rate × scheduled days (audit-trivial; no snapshot needed).
            rate = float(s["daily_rate"]) if s["daily_rate"] is not None else None
            s["daily_rate"] = rate
            s["pay"] = round(rate * len(s["days"]), 2) if rate else 0.0

    totals = {
        "staff_count": len(staff),
        "official_count": len(officials),
        "pay": round(sum(o["pay"] for o in officials), 2),
        "mileage": round(sum((o["mileage"] or 0.0) for o in officials), 2),
        "missing_distance_count": sum(1 for o in officials if o["missing_distance"]),
        "hotel_mismatch_count": sum(1 for o in officials if o["hotel_date_mismatch"]),
        "out_of_window_count": sum(1 for o in officials if o["work_date_out_of_window"]),
        "conflict_count": sum(1 for o in officials if o["has_conflict"]),
        "staff_pay": round(sum(s["pay"] for s in staff), 2),
    }
    totals["total"] = round(totals["pay"] + totals["mileage"], 2)
    return {"tournament": t, "officials": officials, "staff": staff, "totals": totals}
