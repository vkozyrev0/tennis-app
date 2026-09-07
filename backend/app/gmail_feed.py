"""Gmail IMAP feed: stored settings + latest-mail cursor (UID).

The TD saves a Gmail address and an App Password (Fernet-encrypted). Fetch
walks IMAP UIDs newer than ``last_uid`` and hands each message to
``ingest_email`` (``ingest_source='gmail'``). No password is ever returned
on GET — only ``has_secret``.
"""
from __future__ import annotations

import email as email_lib
import imaplib
import re
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parsedate_to_datetime
from typing import Any, Callable

from .crypto import decrypt as _dec
from .crypto import encrypt as _enc
from .email_ingest import IngestPayload, html_to_text, ingest_email

_FEED_ID = 1
_DEFAULTS = {
    "enabled": False,
    "gmail_address": None,
    "imap_host": "imap.gmail.com",
    "imap_port": 993,
    "mailbox": "INBOX",
    "gmail_query": None,
    "poll_minutes": 15,
    "lookback_days": 7,
    "tournament_id": None,
    "last_uid": None,
    "uidvalidity": None,
    "last_fetched_at": None,
    "last_status": None,
    "last_error": None,
    "last_imported": 0,
    "last_duplicates": 0,
}
_MAX_BATCH = 50


def _hdr(msg: Message, name: str) -> str | None:
    raw = msg.get(name)
    if not raw:
        return None
    try:
        return str(make_header(decode_header(raw))).strip() or None
    except (LookupError, UnicodeError, TypeError):
        return str(raw).strip() or None


def _plain_body(msg: Message) -> str | None:
    if msg.is_multipart():
        text = None
        html = None
        for part in msg.walk():
            ctype = (part.get_content_type() or "").lower()
            disp = str(part.get("Content-Disposition") or "").lower()
            if "attachment" in disp:
                continue
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            charset = part.get_content_charset() or "utf-8"
            try:
                decoded = payload.decode(charset, errors="replace")
            except LookupError:
                decoded = payload.decode("utf-8", errors="replace")
            if ctype == "text/plain" and text is None:
                text = decoded
            elif ctype == "text/html" and html is None:
                html = decoded
        return (text or html_to_text(html) or "").strip() or None
    payload = msg.get_payload(decode=True)
    if payload is None:
        raw = msg.get_payload()
        return str(raw).strip() if raw else None
    charset = msg.get_content_charset() or "utf-8"
    try:
        decoded = payload.decode(charset, errors="replace")
    except LookupError:
        decoded = payload.decode("utf-8", errors="replace")
    if (msg.get_content_type() or "").lower() == "text/html":
        return html_to_text(decoded)
    return decoded.strip() or None


def message_to_payload(raw: bytes, *, tournament_id: int | None = None) -> IngestPayload:
    """RFC822 bytes → ingest payload. Used by fetch and unit tests."""
    msg = email_lib.message_from_bytes(raw)
    mid = _hdr(msg, "Message-ID") or _hdr(msg, "Message-Id")
    received = None
    date_hdr = _hdr(msg, "Date")
    if date_hdr:
        try:
            received = parsedate_to_datetime(date_hdr)
            if received.tzinfo is None:
                received = received.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError, IndexError):
            received = None
    return IngestPayload(
        message_id=mid,
        from_address=_hdr(msg, "From"),
        to_address=_hdr(msg, "To"),
        subject=_hdr(msg, "Subject"),
        body=_plain_body(msg),
        tournament_id=tournament_id,
        received_at=received,
        ingest_source="gmail",
    )


def public_row(row: dict | None) -> dict:
    """Client-safe settings: never include the encrypted secret."""
    src = dict(_DEFAULTS)
    if row:
        src.update({k: row.get(k, src.get(k)) for k in _DEFAULTS})
        src["has_secret"] = bool(row.get("secret_enc"))
        src["updated_at"] = row.get("updated_at")
    else:
        src["has_secret"] = False
        src["updated_at"] = None
    fetched = src.get("last_fetched_at")
    if hasattr(fetched, "isoformat"):
        src["last_fetched_at"] = fetched.isoformat()
    updated = src.get("updated_at")
    if hasattr(updated, "isoformat"):
        src["updated_at"] = updated.isoformat()
    return src


def load_feed(cur) -> dict:
    cur.execute("SELECT * FROM gmail_feed WHERE id = %s", (_FEED_ID,))
    row = cur.fetchone()
    if not row:
        cur.execute("INSERT INTO gmail_feed (id) VALUES (%s) ON CONFLICT (id) DO NOTHING",
                    (_FEED_ID,))
        cur.execute("SELECT * FROM gmail_feed WHERE id = %s", (_FEED_ID,))
        row = cur.fetchone()
    return dict(row) if row else dict(_DEFAULTS)


def save_feed(cur, patch: dict) -> dict:
    """Upsert settings. Empty ``app_password`` keeps the stored secret."""
    row = load_feed(cur)
    enabled = bool(patch.get("enabled", row.get("enabled")))
    address = patch.get("gmail_address", row.get("gmail_address"))
    address = str(address).strip() if address else None
    host = str(patch.get("imap_host") or row.get("imap_host") or "imap.gmail.com").strip()
    try:
        port = int(patch.get("imap_port") if patch.get("imap_port") is not None
                   else (row.get("imap_port") or 993))
    except (TypeError, ValueError):
        port = 993
    mailbox = str(patch.get("mailbox") or row.get("mailbox") or "INBOX").strip() or "INBOX"
    query = patch.get("gmail_query", row.get("gmail_query"))
    query = str(query).strip() if query else None
    try:
        poll = max(1, min(24 * 60, int(patch.get("poll_minutes")
                   if patch.get("poll_minutes") is not None
                   else (row.get("poll_minutes") or 15))))
    except (TypeError, ValueError):
        poll = 15
    try:
        lookback = max(1, min(90, int(patch.get("lookback_days")
                        if patch.get("lookback_days") is not None
                        else (row.get("lookback_days") or 7))))
    except (TypeError, ValueError):
        lookback = 7
    tid = patch.get("tournament_id", row.get("tournament_id"))
    if tid in ("", None):
        tid = None
    else:
        try:
            tid = int(tid)
        except (TypeError, ValueError):
            tid = row.get("tournament_id")
    secret = row.get("secret_enc")
    pw = patch.get("app_password")
    reset_cursor = False
    if pw is not None and str(pw).strip():
        secret = _enc(str(pw).strip())
        reset_cursor = True  # new mailbox/secret — start lookback, don't reuse UIDs
    if reset_cursor:
        cur.execute(
            """
            UPDATE gmail_feed SET
                enabled = %s, gmail_address = %s, secret_enc = %s,
                imap_host = %s, imap_port = %s, mailbox = %s, gmail_query = %s,
                poll_minutes = %s, lookback_days = %s, tournament_id = %s,
                last_uid = NULL, uidvalidity = NULL,
                last_status = NULL, last_error = NULL,
                updated_at = now()
            WHERE id = %s
            RETURNING *
            """,
            (enabled, address, secret, host, port, mailbox, query,
             poll, lookback, tid, _FEED_ID),
        )
    else:
        cur.execute(
            """
            UPDATE gmail_feed SET
                enabled = %s, gmail_address = %s, secret_enc = %s,
                imap_host = %s, imap_port = %s, mailbox = %s, gmail_query = %s,
                poll_minutes = %s, lookback_days = %s, tournament_id = %s,
                updated_at = now()
            WHERE id = %s
            RETURNING *
            """,
            (enabled, address, secret, host, port, mailbox, query,
             poll, lookback, tid, _FEED_ID),
        )
    return dict(cur.fetchone())


def _decode_uids(raw) -> list[int]:
    if not raw:
        return []
    blob = raw[0] if isinstance(raw, (list, tuple)) else raw
    if blob in (None, b"", ""):
        return []
    if isinstance(blob, bytes):
        blob = blob.decode("ascii", errors="replace")
    out = []
    for tok in re.findall(r"\d+", str(blob)):
        try:
            out.append(int(tok))
        except ValueError:
            continue
    return out


def _imap_fetch(
    row: dict,
    *,
    imap_factory: Callable[..., Any] | None = None,
) -> tuple[list[tuple[int, bytes]], int | None, int | None]:
    """Return [(uid, rfc822), ...], new last_uid, uidvalidity."""
    address = (row.get("gmail_address") or "").strip()
    secret = _dec(row.get("secret_enc")) or ""
    if not address or not secret:
        raise RuntimeError("Gmail address and app password are required")
    host = row.get("imap_host") or "imap.gmail.com"
    port = int(row.get("imap_port") or 993)
    mailbox = row.get("mailbox") or "INBOX"
    factory = imap_factory or imaplib.IMAP4_SSL
    imap = factory(host, port)
    try:
        typ, _ = imap.login(address, secret)
        if typ != "OK":
            raise RuntimeError("Gmail login failed — check the address and app password")
        typ, _ = imap.select(mailbox, readonly=True)
        if typ != "OK":
            raise RuntimeError(f"Could not open mailbox {mailbox}")
        uv = None
        try:
            _t, data = imap.response("UIDVALIDITY")
            if data and data[0]:
                uv = int(data[0])
        except (TypeError, ValueError, IndexError):
            uv = None
        stored_uv = row.get("uidvalidity")
        last_uid = row.get("last_uid") or 0
        if uv is not None and stored_uv is not None and int(stored_uv) != uv:
            last_uid = 0  # mailbox rebuilt — start over from lookback
        query = (row.get("gmail_query") or "").strip()
        if query:
            typ, data = imap.uid("SEARCH", None, "X-GM-RAW", query)
        elif last_uid:
            typ, data = imap.uid("SEARCH", None, f"{int(last_uid) + 1}:*")
        else:
            days = int(row.get("lookback_days") or 7)
            since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%d-%b-%Y")
            typ, data = imap.uid("SEARCH", None, "SINCE", since)
        if typ != "OK":
            raise RuntimeError("Gmail search failed")
        uids = [u for u in _decode_uids(data) if u > int(last_uid or 0)]
        uids.sort()
        uids = uids[:_MAX_BATCH]
        messages: list[tuple[int, bytes]] = []
        for uid in uids:
            typ, fetched = imap.uid("FETCH", str(uid), "(RFC822)")
            if typ != "OK" or not fetched:
                continue
            raw = None
            for item in fetched:
                if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], (bytes, bytearray)):
                    raw = bytes(item[1])
                    break
            if raw:
                messages.append((uid, raw))
        new_last = max([last_uid] + [u for u, _ in messages]) if messages else last_uid
        return messages, int(new_last) if new_last else last_uid, uv
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def fetch_latest(cur, *, imap_factory: Callable[..., Any] | None = None) -> dict:
    """Pull new IMAP messages and ingest them. Updates the UID cursor."""
    row = load_feed(cur)
    if not row.get("enabled"):
        raise RuntimeError("Gmail feed is disabled — enable it on Setup → Gmail")
    try:
        messages, new_last, uv = _imap_fetch(row, imap_factory=imap_factory)
    except Exception as exc:
        cur.execute(
            """
            UPDATE gmail_feed SET last_fetched_at = now(), last_status = 'error',
                   last_error = %s WHERE id = %s
            """,
            (str(exc)[:500], _FEED_ID),
        )
        raise
    imported = 0
    dupes = 0
    errors = []
    tid = row.get("tournament_id")
    for _uid, raw in messages:
        try:
            payload = message_to_payload(raw, tournament_id=tid)
            result = ingest_email(cur, payload, auto_classify=True)
            if result.get("duplicate"):
                dupes += 1
            else:
                imported += 1
        except Exception as exc:
            errors.append(str(exc)[:200])
    status = "ok" if not errors else "partial"
    err = "; ".join(errors[:3]) if errors else None
    cur.execute(
        """
        UPDATE gmail_feed SET
            last_uid = %s, uidvalidity = %s, last_fetched_at = now(),
            last_status = %s, last_error = %s,
            last_imported = %s, last_duplicates = %s
        WHERE id = %s
        RETURNING *
        """,
        (new_last, uv, status, err, imported, dupes, _FEED_ID),
    )
    out = public_row(dict(cur.fetchone()))
    out["fetched"] = len(messages)
    out["imported"] = imported
    out["duplicates"] = dupes
    return out
