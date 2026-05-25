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

        officials = []
        for a in rows:
            s = _summary(cur, a)
            cur.execute(
                "SELECT dietary_restrictions FROM official WHERE id = %s",
                (a["official_id"],),
            )
            s["dietary_restrictions"] = cur.fetchone()["dietary_restrictions"]
            officials.append(s)

    totals = {
        "official_count": len(officials),
        "pay": round(sum(o["pay"] for o in officials), 2),
        "mileage": round(sum((o["mileage"] or 0.0) for o in officials), 2),
        "missing_distance_count": sum(1 for o in officials if o["missing_distance"]),
        "hotel_mismatch_count": sum(1 for o in officials if o["hotel_date_mismatch"]),
    }
    totals["total"] = round(totals["pay"] + totals["mileage"], 2)
    return {"tournament": t, "officials": officials, "totals": totals}
