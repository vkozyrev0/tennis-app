"""Setup → Gmail: store IMAP settings and fetch latest mail."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..db import db_dep
from ..gmail_feed import fetch_latest, load_feed, public_row, save_feed

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
    with conn.cursor() as cur:
        row = save_feed(cur, body.model_dump(exclude_unset=True))
    return public_row(row)


@router.post("/fetch")
def fetch_gmail_feed(conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            return fetch_latest(cur)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=502, detail=f"Gmail IMAP error: {e}") from e
