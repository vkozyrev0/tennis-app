"""Part B review inbox: inbound parent/player email, filed by a human (D5/§5.1)."""
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import EmailCreate, EmailOut, EmailUpdate

router = APIRouter(prefix="/api/emails", tags=["emails"])

_COLS = (
    "id, tournament_id, message_id, received_at, from_address, subject, body, "
    "classification, status"
)


@router.get("", response_model=list[EmailOut])
def list_emails(tournament_id: int | None = None, status: str | None = None, conn=Depends(db_dep)):
    clauses, params = [], []
    if tournament_id is not None:
        clauses.append("tournament_id = %s"); params.append(tournament_id)
    if status is not None:
        clauses.append("status = %s"); params.append(status)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM email_message{where} ORDER BY received_at DESC", params)
        return cur.fetchall()


@router.post("", response_model=EmailOut, status_code=201)
def create_email(body: EmailCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO email_message (tournament_id, message_id, from_address, subject, body)
                VALUES (%(tournament_id)s, %(message_id)s, %(from_address)s, %(subject)s, %(body)s)
                RETURNING {_COLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="an email with this message_id already exists")


@router.put("/{email_id}", response_model=EmailOut)
def update_email(email_id: int, body: EmailUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE email_message SET
                tournament_id = %(tournament_id)s, classification = %(classification)s,
                status = %(status)s
            WHERE id = %(id)s RETURNING {_COLS}
            """,
            {**body.model_dump(), "id": email_id},
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="email not found")
    return row


@router.delete("/{email_id}", status_code=204)
def delete_email(email_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM email_message WHERE id = %s", (email_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="email not found")
    return Response(status_code=204)
