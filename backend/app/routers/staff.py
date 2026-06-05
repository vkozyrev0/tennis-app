"""Non-official tournament staff (Site Director, Trainer, Stringer, …).

The officials model covers certified officials with pay/mileage; these support
roles are a simpler per-tournament roster (name + role + contact) that rounds out
the TD's staffing-plan report. Tournament-scoped, like the Part B lists.
"""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import StaffCreate, StaffOut

router = APIRouter(tags=["staff"])

# Aggregate each staff member's worked days into a `days` array so StaffOut
# carries them (mirrors the officials roster's per-day shape).
_SELECT = (
    "SELECT s.id, s.tournament_id, s.name, s.role, s.phone, s.email, s.notes, "
    "       s.daily_rate, "
    "       COALESCE(array_agg(d.work_date ORDER BY d.work_date) "
    "                FILTER (WHERE d.work_date IS NOT NULL), '{}') AS days "
    "FROM tournament_staff s LEFT JOIN staff_day d ON d.staff_id = s.id "
)


def _tournament_or_404(cur, tournament_id: int) -> None:
    cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="tournament not found")


def _one(cur, staff_id: int):
    cur.execute(_SELECT + "WHERE s.id = %s GROUP BY s.id", (staff_id,))
    return cur.fetchone()


def _replace_days(cur, staff_id: int, days) -> None:
    """Replace the staff member's days with the given set (no-op when days=None)."""
    if days is None:
        return
    cur.execute("DELETE FROM staff_day WHERE staff_id = %s", (staff_id,))
    for d in dict.fromkeys(days):  # de-dup, preserve order
        cur.execute(
            "INSERT INTO staff_day (staff_id, work_date) VALUES (%s, %s)",
            (staff_id, d),
        )


@router.get("/api/tournaments/{tournament_id}/staff", response_model=list[StaffOut])
def list_staff(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            _SELECT + "WHERE s.tournament_id = %s GROUP BY s.id ORDER BY s.role, s.name",
            (tournament_id,),
        )
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/staff",
             response_model=StaffOut, status_code=201)
def create_staff(tournament_id: int, body: StaffCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _tournament_or_404(cur, tournament_id)
        cur.execute(
            """
            INSERT INTO tournament_staff
                (tournament_id, name, role, phone, email, notes, daily_rate)
            VALUES (%(tournament_id)s, %(name)s, %(role)s, %(phone)s, %(email)s,
                    %(notes)s, %(daily_rate)s)
            RETURNING id
            """,
            {**body.model_dump(exclude={"days"}), "tournament_id": tournament_id},
        )
        new_id = cur.fetchone()["id"]
        _replace_days(cur, new_id, body.days)
        return _one(cur, new_id)


@router.put("/api/staff/{staff_id}", response_model=StaffOut)
def update_staff(staff_id: int, body: StaffCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE tournament_staff SET
                name = %(name)s, role = %(role)s, phone = %(phone)s,
                email = %(email)s, notes = %(notes)s, daily_rate = %(daily_rate)s
            WHERE id = %(id)s RETURNING id
            """,
            {**body.model_dump(exclude={"days"}), "id": staff_id},
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="staff member not found")
        _replace_days(cur, staff_id, body.days)
        return _one(cur, staff_id)


@router.delete("/api/staff/{staff_id}", status_code=204)
def delete_staff(staff_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM tournament_staff WHERE id = %s", (staff_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="staff member not found")
    return Response(status_code=204)
