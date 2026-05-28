"""Certifications an official holds (roving / chair / referee)."""
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import CertificationCreate, CertificationOut

router = APIRouter(tags=["certifications"])


@router.get("/api/officials/{official_id}/certifications", response_model=list[CertificationOut])
def list_certifications(official_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, official_id, cert_type FROM certification "
            "WHERE official_id = %s ORDER BY cert_type",
            (official_id,),
        )
        return cur.fetchall()


@router.post("/api/officials/{official_id}/certifications",
             response_model=CertificationOut, status_code=201)
def add_certification(official_id: int, body: CertificationCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO certification (official_id, cert_type) VALUES (%s, %s) "
                "RETURNING id, official_id, cert_type",
                (official_id, body.cert_type),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="official already has this certification")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id does not exist")


@router.delete("/api/certifications/{cert_id}", status_code=204)
def delete_certification(cert_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM certification WHERE id = %s", (cert_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="certification not found")
    return Response(status_code=204)
