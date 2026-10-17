"""Setup → Gmail: store IMAP settings and fetch latest mail."""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..db import db_dep
from ..gmail_feed import ALLOWED_IMAP_HOSTS, fetch_latest, load_feed, public_row, save_feed
from ..inbox_feeds import as_window

router = APIRouter(prefix="/api/gmail-feed", tags=["gmail-feed"])


class GmailFeedUpdate(BaseModel):
    enabled: Optional[bool] = None
    gmail_address: Optional[str] = None
    app_password: Optional[str] = Field(default=None, description="Gmail App Password; omit to keep")
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    mailbox: Optional[str] = None
    gmail_query: Optional[str] = None
    poll_minutes: Optional[int] = None
    lookback_days: Optional[int] = None
    tournament_id: Optional[int] = None


@router.get("")
def get_gmail_feed(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        return public_row(load_feed(cur))


@router.put("")
def put_gmail_feed(body: GmailFeedUpdate, conn=Depends(db_dep)):
    data = body.model_dump(exclude_unset=True)
    if data.get("imap_host") is not None:
        host = str(data["imap_host"]).strip().lower()
        if host not in ALLOWED_IMAP_HOSTS:
            raise HTTPException(
                status_code=400,
                detail="imap_host must be imap.gmail.com (the feed sends the stored app password there)",
            )
        data["imap_host"] = host
    if data.get("imap_port") not in (None, 993):
        raise HTTPException(status_code=400, detail="imap_port must be 993 (IMAP over TLS)")
    with conn.cursor() as cur:
        row = save_feed(cur, data)
    return public_row(row)


@router.post("/fetch")
def fetch_gmail_feed(
    since: Optional[date] = None,
    until: Optional[date] = None,
    conn=Depends(db_dep),
):
    start, end = as_window(since, until)
    try:
        with conn.cursor() as cur:
            return fetch_latest(cur, since=start, until=end)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=502, detail=f"Gmail IMAP error: {e}") from e
