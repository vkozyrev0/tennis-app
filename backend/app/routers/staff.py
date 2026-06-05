"""Non-official tournament staff (Site Director, Trainer, Stringer, …).

The officials model covers certified officials with pay/mileage; these support
roles are a simpler per-tournament roster (name + role + contact) that rounds out
the TD's staffing-plan report. Tournament-scoped, like the Part B lists.
"""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import StaffCreate, StaffOut

router = APIRouter(tags=["staff"])

_COLS = "id, tournament_id, name, role, phone, email, notes"


def _tournament_or_404(cur, tournament_id: int) -> None:
    cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="tournament not found")


@router.get("/api/tournaments/{tournament_id}/staff", response_model=list[StaffOut])
def list_staff(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLS} FROM tournament_staff WHERE tournament_id = %s "
            "ORDER BY role, name",
            (tournament_id,),
        )
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/staff",
             response_model=StaffOut, status_code=201)
def create_staff(tournament_id: int, body: StaffCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _tournament_or_404(cur, tournament_id)
        cur.execute(
            f"""
            INSERT INTO tournament_staff (tournament_id, name, role, phone, email, notes)
            VALUES (%(tournament_id)s, %(name)s, %(role)s, %(phone)s, %(email)s, %(notes)s)
            RETURNING {_COLS}
            """,
            {**body.model_dump(), "tournament_id": tournament_id},
        )
        return cur.fetchone()


@router.put("/api/staff/{staff_id}", response_model=StaffOut)
def update_staff(staff_id: int, body: StaffCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE tournament_staff SET
                name = %(name)s, role = %(role)s, phone = %(phone)s,
                email = %(email)s, notes = %(notes)s
            WHERE id = %(id)s
            RETURNING {_COLS}
            """,
            {**body.model_dump(), "id": staff_id},
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="staff member not found")
        return row


@router.delete("/api/staff/{staff_id}", status_code=204)
def delete_staff(staff_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM tournament_staff WHERE id = %s", (staff_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="staff member not found")
    return Response(status_code=204)
