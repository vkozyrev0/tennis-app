"""Inbox Get mails: run enabled Gmail + Outlook fetches for a date window."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Callable

from . import gmail_feed, outlook_feed
from .email_ingest import restore_hidden

HttpFn = Callable[..., Any]


def as_window(since, until) -> tuple[datetime | None, datetime | None]:
    """Normalize since/until (date, datetime, or ISO str) to UTC datetimes."""
    return _as_dt(since, end=False), _as_dt(until, end=True)


def _as_dt(raw, *, end: bool) -> datetime | None:
    if raw in (None, ""):
        return None
    if isinstance(raw, datetime):
        dt = raw
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    if isinstance(raw, date):
        t = time.max if end else time.min
        return datetime.combine(raw, t, tzinfo=timezone.utc)
    s = str(raw).strip()
    if not s:
        return None
    if len(s) <= 10:
        d = date.fromisoformat(s[:10])
        t = time.max if end else time.min
        return datetime.combine(d, t, tzinfo=timezone.utc)
    iso = s.replace("Z", "+00:00") if s.endswith("Z") else s
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def gmail_ready(row: dict | None) -> bool:
    if not row or not row.get("enabled"):
        return False
    addr = (row.get("gmail_address") or "").strip()
    return bool(addr and row.get("secret_enc"))


def outlook_ready(row: dict | None) -> bool:
    if not row or not row.get("enabled"):
        return False
    box = (row.get("mailbox") or "").strip()
    return bool(box and row.get("secret_enc"))


def _event_lookback_start(cur, tournament_id: int | None) -> datetime:
    """Earliest time Get all should ask the mailbox for (event start, else 90 days)."""
    fallback = datetime.now(timezone.utc) - timedelta(days=90)
    if not tournament_id:
        return fallback
    cur.execute(
        "SELECT play_start_date FROM tournament WHERE id = %s AND deleted_at IS NULL",
        (tournament_id,),
    )
    row = cur.fetchone()
    raw = (row or {}).get("play_start_date") if row else None
    if raw is None:
        return fallback
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    return datetime.combine(raw, time.min, tzinfo=timezone.utc)


def fetch_inbox_mails(
    cur,
    *,
    since=None,
    until=None,
    tournament_id: int | None = None,
    get_all: bool = False,
    imap_factory: Callable[..., Any] | None = None,
    http: HttpFn | None = None,
) -> dict:
    """Fetch enabled, configured feeds for [since, until]. Skip the rest.

    ``get_all`` widens ``since`` back to the event start (or 90 days) so mail
    older than the default 7-day window is requested, then un-hides any
    remaining soft-deleted CourtOps copies for the tournament.
    """
    start, end = as_window(since, until)
    if get_all:
        event_start = _event_lookback_start(cur, tournament_id)
        if start is None or start > event_start:
            start = event_start
        if end is None:
            end = datetime.now(timezone.utc)
    skipped: list[str] = []
    gmail_out = None
    outlook_out = None
    grow = gmail_feed.load_feed(cur)
    if gmail_ready(grow):
        gmail_out = gmail_feed.fetch_latest(
            cur, imap_factory=imap_factory, since=start, until=end,
            tournament_id=tournament_id,
        )
    else:
        skipped.append("gmail")
    orow = outlook_feed.load_feed(cur)
    if outlook_ready(orow):
        outlook_out = outlook_feed.fetch_latest(
            cur, http=http, since=start, until=end,
            tournament_id=tournament_id,
        )
    else:
        skipped.append("outlook")
    restored = 0
    if get_all and tournament_id is not None:
        restored = restore_hidden(cur, tournament_id)
    imported = (
        (gmail_out or {}).get("imported", 0)
        + (outlook_out or {}).get("imported", 0)
        + restored
    )
    duplicates = (gmail_out or {}).get("duplicates", 0) + (outlook_out or {}).get("duplicates", 0)
    return {
        "gmail": gmail_out,
        "outlook": outlook_out,
        "skipped": skipped,
        "imported": imported,
        "duplicates": duplicates,
        "restored": restored,
    }
