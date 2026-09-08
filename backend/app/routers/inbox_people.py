"""Inbox-parallel people list (name + USTA) and promote-to-Players."""
from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from ..inbox_person import get_inbox_person, list_inbox_people, promote_inbox_person
from ..models import InboxPersonOut, InboxPersonPromote

router = APIRouter(prefix="/api/inbox-people", tags=["inbox-people"])


@router.get("", response_model=list[InboxPersonOut])
def list_people(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        return list_inbox_people(cur)


@router.get("/{person_id}", response_model=InboxPersonOut)
def get_person(person_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        row = get_inbox_person(cur, person_id)
    if row is None:
        raise HTTPException(status_code=404, detail="inbox person not found")
    return row


@router.post("/{person_id}/promote", response_model=InboxPersonOut)
def promote_person(person_id: int, body: InboxPersonPromote | None = None,
                   conn=Depends(db_dep)):
    payload = body or InboxPersonPromote()
    with conn.cursor() as cur:
        return promote_inbox_person(
            cur, person_id,
            gender=payload.gender, usta_number=payload.usta_number,
        )
