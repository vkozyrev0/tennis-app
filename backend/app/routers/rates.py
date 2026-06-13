import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import CertificationRateCreate, CertificationRateOut

router = APIRouter(prefix="/api/rates", tags=["rates"])

_COLS = "id, cert_type, rate_per_day, effective_from"


@router.get("", response_model=list[CertificationRateOut])
def list_rates(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM certification_rate ORDER BY cert_type, effective_from DESC")
        return cur.fetchall()


@router.post("", response_model=CertificationRateOut, status_code=201)
def create_rate(body: CertificationRateCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO certification_rate (cert_type, rate_per_day, effective_from)
                VALUES (%(cert_type)s, %(rate_per_day)s, %(effective_from)s)
                RETURNING {_COLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(
            status_code=409, detail="a rate for this type/effective_from already exists"
        )


@router.put("/{rate_id}", response_model=CertificationRateOut)
def update_rate(rate_id: int, body: CertificationRateCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE certification_rate SET
                    cert_type = %(cert_type)s,
                    rate_per_day = %(rate_per_day)s,
                    effective_from = %(effective_from)s
                WHERE id = %(id)s
                RETURNING {_COLS}
                """,
                {**body.model_dump(), "id": rate_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(
            status_code=409, detail="a rate for this type/effective_from already exists"
        )
    if row is None:
        raise HTTPException(status_code=404, detail="rate not found")
    return row


@router.delete("/{rate_id}", status_code=204)
def delete_rate(rate_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM certification_rate WHERE id = %s", (rate_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="rate not found")
    return Response(status_code=204)
