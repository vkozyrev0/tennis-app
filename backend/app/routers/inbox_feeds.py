"""Inbox Get mails: date-window fetch of enabled Gmail + Outlook feeds."""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from ..email_llm import probe_llm
from ..email_stamp import list_window_ids
from ..inbox_feeds import fetch_inbox_mails
from ..outlook_feed import _redact

router = APIRouter(prefix="/api/inbox-feeds", tags=["inbox-feeds"])


@router.post("/fetch")
def fetch_inbox_feeds(
    since: Optional[date] = None,
    until: Optional[date] = None,
    tournament_id: Optional[int] = None,
    get_all: bool = False,
    reprocess: bool = False,
    conn=Depends(db_dep),
):
    try:
        with conn.cursor() as cur:
            return fetch_inbox_mails(
                cur, since=since, until=until, tournament_id=tournament_id,
                get_all=get_all, reprocess=reprocess,
            )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=_redact(str(e))) from e
    except OSError as e:
        raise HTTPException(status_code=502, detail=_redact(str(e))) from e


@router.get("/reprocess-ids")
def list_reprocess_ids(
    since: Optional[date] = None,
    until: Optional[date] = None,
    tournament_id: Optional[int] = None,
    get_all: bool = False,
    conn=Depends(db_dep),
):
    """Ids of stored inbox copies in the date range, plus leftover-LLM status.

    Inbox shows the whole tournament; an empty date window therefore falls
    back to every visible copy (``fallback: tournament``) so Reprocess range
    does not finish on zero while the grid is full. ``get_all`` skips the
    date filter the same way Get mails does.
    """
    if tournament_id is None:
        raise HTTPException(status_code=400, detail="tournament_id is required")
    with conn.cursor() as cur:
        window_ids = list_window_ids(
            cur, tournament_id, since, until, get_all=False,
        )
        all_ids = list_window_ids(
            cur, tournament_id, None, None, get_all=True,
        )
    if get_all:
        ids, fallback, window_count = all_ids, None, len(all_ids)
    elif window_ids:
        ids, fallback, window_count = window_ids, None, len(window_ids)
    elif all_ids:
        ids, fallback, window_count = all_ids, "tournament", 0
    else:
        ids, fallback, window_count = [], None, 0
    return {
        "ids": ids,
        "count": len(ids),
        "window_count": window_count,
        "tournament_count": len(all_ids),
        "fallback": fallback,
        "leftover": probe_llm(),
        "since": since.isoformat() if since else None,
        "until": until.isoformat() if until else None,
    }
