"""Setup → Outlook: store Microsoft Graph settings and fetch latest mail."""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..db import db_dep
from ..inbox_feeds import as_window
from ..outlook_feed import _redact, fetch_latest, load_feed, public_row, save_feed

router = APIRouter(prefix="/api/outlook-feed", tags=["outlook-feed"])


class OutlookFeedUpdate(BaseModel):
    enabled: Optional[bool] = None
    tenant_id: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = Field(default=None, description="Entra client secret; omit to keep")
    mailbox: Optional[str] = None
    mail_query: Optional[str] = None
    poll_minutes: Optional[int] = None
    lookback_days: Optional[int] = None
    tournament_id: Optional[int] = None
    client_secret_expires: Optional[str] = None


@router.get("")
def get_outlook_feed(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        return public_row(load_feed(cur))


@router.put("")
def put_outlook_feed(body: OutlookFeedUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        row = save_feed(cur, body.model_dump(exclude_unset=True))
    return public_row(row)


@router.post("/fetch")
def fetch_outlook_feed(
    since: Optional[date] = None,
    until: Optional[date] = None,
    conn=Depends(db_dep),
):
    start, end = as_window(since, until)
    try:
        with conn.cursor() as cur:
            return fetch_latest(cur, since=start, until=end)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=_redact(str(e))) from e
    except OSError as e:
        raise HTTPException(status_code=502, detail=_redact(f"Outlook / Graph error: {e}")) from e
