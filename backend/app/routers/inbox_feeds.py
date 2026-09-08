"""Inbox Get mails: date-window fetch of enabled Gmail + Outlook feeds."""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from ..inbox_feeds import fetch_inbox_mails
from ..outlook_feed import _redact

router = APIRouter(prefix="/api/inbox-feeds", tags=["inbox-feeds"])


@router.post("/fetch")
def fetch_inbox_feeds(
    since: Optional[date] = None,
    until: Optional[date] = None,
    tournament_id: Optional[int] = None,
    get_all: bool = False,
    conn=Depends(db_dep),
):
    try:
        with conn.cursor() as cur:
            return fetch_inbox_mails(
                cur, since=since, until=until, tournament_id=tournament_id,
                get_all=get_all,
            )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=_redact(str(e))) from e
    except OSError as e:
        raise HTTPException(status_code=502, detail=_redact(str(e))) from e
