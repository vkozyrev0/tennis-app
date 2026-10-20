"""Inbox Get mails: run enabled Gmail + Outlook fetches for a date window."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Callable

from . import gmail_feed, outlook_feed
from .email_ingest import restore_hidden
from .email_llm import pass_budget
from .inbox_progress import NullReporter, feed_callbacks, finalize_feed

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


def _feed_progress(out: dict | None) -> dict | None:
    """The counts a feed's fetch reported, or None when the feed was skipped."""
    if out is None:
        return None
    return {
        "downloaded": int(out.get("fetched") or 0),
        "imported": int(out.get("imported") or 0),
        "duplicates": int(out.get("duplicates") or 0),
    }


def fetch_inbox_mails(
    cur,
    *,
    since=None,
    until=None,
    tournament_id: int | None = None,
    get_all: bool = False,
    reprocess: bool = False,
    imap_factory: Callable[..., Any] | None = None,
    http: HttpFn | None = None,
    reporter=None,
) -> dict:
    """Fetch enabled, configured feeds for [since, until]. Skip the rest.

    ``get_all`` widens ``since`` back to the event start (or 90 days) so mail
    older than the default 7-day window is requested, then un-hides any
    remaining soft-deleted CourtOps copies for the tournament.
    ``reprocess`` re-runs classify + leftover stamp on CourtOps copies in the
    window after the mailbox fetch (no duplicate rows).
    """
    if reporter is not None:
        reporter.stage("reading")
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
    # One model budget for the whole request: the download phase spends none of
    # it, so the classify phase (one round trip per leftover copy) is what it
    # bounds. Copies the budget refuses are still imported, classified by the
    # heuristic, and counted in `leftover_skipped` for the status line.
    with pass_budget() as budget:
        reporter = reporter or NullReporter()
        grow = gmail_feed.load_feed(cur)
        if gmail_ready(grow):
            on_dl, on_cls = feed_callbacks(reporter, "gmail")
            gmail_out = gmail_feed.fetch_latest(
                cur, imap_factory=imap_factory, since=start, until=end,
                tournament_id=tournament_id, on_download=on_dl, on_classify=on_cls,
            )
            finalize_feed(reporter, "gmail", gmail_out)
        else:
            skipped.append("gmail")
        orow = outlook_feed.load_feed(cur)
        if outlook_ready(orow):
            on_dl, on_cls = feed_callbacks(reporter, "outlook")
            outlook_out = outlook_feed.fetch_latest(
                cur, http=http, since=start, until=end,
                tournament_id=tournament_id, on_download=on_dl, on_classify=on_cls,
            )
            finalize_feed(reporter, "outlook", outlook_out)
        else:
            skipped.append("outlook")
        restored = 0
        if get_all and tournament_id is not None:
            restored = restore_hidden(cur, tournament_id, start, end)
        reprocessed = 0
        reprocess_remaining = 0
        if reprocess and tournament_id is not None and (start is not None or end is not None):
            from .email_stamp import reprocess_window
            out = reprocess_window(cur, tournament_id, start, end)
            reprocessed = out.get("reprocessed", 0)
            reprocess_remaining = out.get("remaining", 0)
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
        "reprocessed": reprocessed,
        "reprocess_remaining": reprocess_remaining,
        "leftover_skipped": budget.denied,
        "llm_budget": budget.as_dict(),
        "progress": {"gmail": _feed_progress(gmail_out), "outlook": _feed_progress(outlook_out)},
    }
