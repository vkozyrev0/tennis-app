"""Inbound email auto-ingest helpers (D4).

Normalizes webhook/form payloads into a common shape, routes them to a
tournament via ``tournament.ingest_address`` (or an explicit id / default),
and inserts into ``email_message`` with body encryption + optional keyword
classification. No LLM — human review still files every message.

Providers (Mailgun, SendGrid Inbound Parse, Cloudflare Email Workers, curl,
etc.) all map into :func:`ingest_email` after field normalization.
"""
from __future__ import annotations

import html as html_lib
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import psycopg

from .crypto import encrypt as _enc_body
from .email_extract import compute_extracted_fields
from .triage import classify
import json

_MSG_ID_RE = re.compile(r"<([^>]+)>")
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t]+\n")


@dataclass
class IngestPayload:
    """Normalized inbound message ready to store."""
    message_id: str | None
    from_address: str | None
    to_address: str | None
    subject: str | None
    body: str | None
    tournament_id: int | None = None
    received_at: datetime | None = None
    ingest_source: str = "webhook"


def normalize_message_id(raw: str | None) -> str | None:
    """Strip whitespace/brackets; return None when empty."""
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None
    m = _MSG_ID_RE.search(s)
    if m:
        s = m.group(1).strip()
    # Some providers pass bare ids without angle brackets.
    return s or None


def _first_nonempty(*vals: Any) -> str | None:
    for v in vals:
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return None


def html_to_text(raw: str | None) -> str | None:
    """Best-effort HTML → plain text for providers that only send HTML bodies."""
    if not raw:
        return raw
    s = str(raw)
    # Drop script/style blocks, then tags.
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</p\s*>", "\n\n", s)
    s = re.sub(r"(?i)</div\s*>", "\n", s)
    s = _TAG_RE.sub(" ", s)
    s = html_lib.unescape(s)
    s = _WS_RE.sub("\n", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip() or None


def parse_received_at(raw: Any) -> datetime | None:
    """Parse ISO / RFC2822 / unix-seconds into an aware UTC datetime."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)):
        try:
            return datetime.fromtimestamp(float(raw), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    s = str(raw).strip()
    if not s:
        return None
    # Unix seconds as string
    if re.fullmatch(r"\d{9,12}", s):
        try:
            return datetime.fromtimestamp(int(s), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        # Allow trailing Z
        iso = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError, IndexError):
        return None


def extract_addresses(raw: str | None) -> list[str]:
    """Split a To/Cc header into individual addresses (lowercased)."""
    if not raw:
        return []
    # "Name <a@b.com>, c@d.com" → ["a@b.com", "c@d.com"]
    parts = re.split(r"\s*,\s*", str(raw))
    out: list[str] = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        m = re.search(r"<([^>]+)>", p)
        addr = (m.group(1) if m else p).strip().lower()
        # Drop display-name residue without @ when we already have one.
        if addr and addr not in out:
            out.append(addr)
    return out


def local_part(address: str | None) -> str | None:
    if not address:
        return None
    a = address.strip().lower()
    if "@" in a:
        return a.split("@", 1)[0] or None
    return a or None


def payload_from_mapping(data: dict[str, Any], *, source: str = "webhook") -> IngestPayload:
    """Normalize a JSON (or form-dict) body into :class:`IngestPayload`.

    Accepts our canonical field names plus common provider aliases
    (Mailgun, SendGrid Inbound Parse, generic RFC822-ish keys).
    """
    # Case-insensitive key access for form dumps
    lower = {str(k).lower(): v for k, v in data.items()}

    def g(*names: str) -> Any:
        for n in names:
            if n in data and data[n] not in (None, ""):
                return data[n]
            ln = n.lower()
            if ln in lower and lower[ln] not in (None, ""):
                return lower[ln]
        return None

    body = _first_nonempty(
        g("body"), g("body-plain"), g("body_plain"), g("stripped-text"),
        g("stripped_text"), g("text"), g("plain"), g("TextBody"),
    )
    if not body:
        html_body = _first_nonempty(
            g("body-html"), g("body_html"), g("html"), g("HtmlBody"),
            g("stripped-html"), g("stripped_html"),
        )
        body = html_to_text(html_body)

    mid = normalize_message_id(_first_nonempty(
        g("message_id"), g("Message-Id"), g("Message-ID"), g("message-id"),
        g("MessageID"), g("headers[Message-Id]"),
    ))

    from_addr = _first_nonempty(
        g("from_address"), g("from"), g("sender"), g("From"),
    )
    to_addr = _first_nonempty(
        g("to_address"), g("to"), g("recipient"), g("recipients"),
        g("To"), g("envelope[to]"),
    )
    # If "to" is a list/JSON array string, take the first.
    if to_addr and to_addr.startswith("["):
        try:
            import json
            arr = json.loads(to_addr)
            if isinstance(arr, list) and arr:
                to_addr = str(arr[0])
        except Exception:
            pass

    subject = _first_nonempty(g("subject"), g("Subject"))

    tid_raw = g("tournament_id")
    tournament_id = None
    if tid_raw is not None and str(tid_raw).strip() != "":
        try:
            tournament_id = int(tid_raw)
        except (TypeError, ValueError):
            tournament_id = None

    received_at = parse_received_at(g(
        "received_at", "timestamp", "Date", "date", "DateHeader",
    ))

    return IngestPayload(
        message_id=mid,
        from_address=from_addr,
        to_address=to_addr,
        subject=subject,
        body=body,
        tournament_id=tournament_id,
        received_at=received_at,
        ingest_source=source,
    )


def default_tournament_id() -> int | None:
    raw = os.getenv("INGEST_DEFAULT_TOURNAMENT_ID", "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def resolve_tournament_id(
    cur,
    *,
    explicit_id: int | None,
    to_address: str | None,
) -> int | None:
    """Pick a tournament for the inbound message.

    Priority: explicit id (validated) → match ``to_address`` against
    ``tournament.ingest_address`` → ``INGEST_DEFAULT_TOURNAMENT_ID``.
    """
    if explicit_id is not None:
        cur.execute(
            "SELECT id FROM tournament WHERE id = %s AND deleted_at IS NULL",
            (explicit_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise LookupError(f"tournament_id={explicit_id} not found")
        return row["id"]

    addrs = extract_addresses(to_address)
    # Also try the raw string as a single address if extraction failed.
    if not addrs and to_address:
        addrs = [to_address.strip().lower()]

    for addr in addrs:
        local = local_part(addr)
        # Match full address OR local-part against stored ingest_address.
        cur.execute(
            """
            SELECT id FROM tournament
            WHERE deleted_at IS NULL
              AND ingest_address IS NOT NULL
              AND (
                    lower(ingest_address) = %s
                 OR lower(ingest_address) = %s
                 OR lower(split_part(ingest_address, '@', 1)) = %s
              )
            LIMIT 1
            """,
            (addr, local or "", local or ""),
        )
        row = cur.fetchone()
        if row:
            return row["id"]

    return default_tournament_id()


def ingest_email(cur, payload: IngestPayload, *, auto_classify: bool = True) -> dict:
    """Insert (or dedup) one inbound email. Returns a result dict.

    On unique ``message_id`` collision returns ``{"duplicate": True, "id": …}``
    so webhooks can ACK without retry storms. New rows encrypt the body and
    optionally pre-fill a keyword classification (status stays ``new``).
    """
    if not payload.subject and not payload.body and not payload.from_address:
        raise ValueError("empty message: need at least subject, body, or from_address")

    try:
        tournament_id = resolve_tournament_id(
            cur,
            explicit_id=payload.tournament_id,
            to_address=payload.to_address,
        )
    except LookupError:
        raise

    classification = "unclassified"
    if auto_classify:
        classification = classify(payload.subject, payload.body) or "unclassified"

    enc_body = _enc_body(payload.body)
    fields = compute_extracted_fields(
        payload.subject, payload.body, classification, has_detected_player=False,
    )
    pairs_json = (
        json.dumps(fields["detected_name_pairs"])
        if fields["detected_name_pairs"] is not None else None
    )
    received_at = payload.received_at  # None → DB default now()

    if payload.message_id:
        cur.execute(
            "SELECT id, tournament_id, classification, status "
            "FROM email_message WHERE message_id = %s",
            (payload.message_id,),
        )
        existing = cur.fetchone()
        if existing:
            return {
                "id": existing["id"],
                "duplicate": True,
                "tournament_id": existing["tournament_id"],
                "classification": existing["classification"],
                "status": existing["status"],
            }

    try:
        if received_at is not None:
            cur.execute(
                """
                INSERT INTO email_message (
                    tournament_id, message_id, from_address, to_address,
                    subject, body, classification, status,
                    detected_usta_text, detected_reason, detected_division,
                    detected_events, detected_name_pairs, detected_avoid_day,
                    detected_avoid_time, detected_text_ready,
                    ingest_source, received_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, 'new',
                    %s, %s, %s, %s, %s::jsonb, %s, %s, TRUE,
                    %s, %s
                )
                RETURNING id, tournament_id, classification, status, message_id
                """,
                (
                    tournament_id, payload.message_id, payload.from_address,
                    payload.to_address, payload.subject, enc_body,
                    classification,
                    fields["detected_usta_text"], fields["detected_reason"],
                    fields["detected_division"], fields["detected_events"],
                    pairs_json, fields["detected_avoid_day"],
                    fields["detected_avoid_time"],
                    payload.ingest_source, received_at,
                ),
            )
        else:
            cur.execute(
                """
                INSERT INTO email_message (
                    tournament_id, message_id, from_address, to_address,
                    subject, body, classification, status,
                    detected_usta_text, detected_reason, detected_division,
                    detected_events, detected_name_pairs, detected_avoid_day,
                    detected_avoid_time, detected_text_ready,
                    ingest_source
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, 'new',
                    %s, %s, %s, %s, %s::jsonb, %s, %s, TRUE,
                    %s
                )
                RETURNING id, tournament_id, classification, status, message_id
                """,
                (
                    tournament_id, payload.message_id, payload.from_address,
                    payload.to_address, payload.subject, enc_body,
                    classification,
                    fields["detected_usta_text"], fields["detected_reason"],
                    fields["detected_division"], fields["detected_events"],
                    pairs_json, fields["detected_avoid_day"],
                    fields["detected_avoid_time"],
                    payload.ingest_source,
                ),
            )
    except psycopg.errors.UniqueViolation:
        # Race: another worker inserted the same message_id between SELECT and INSERT.
        cur.execute(
            "SELECT id, tournament_id, classification, status "
            "FROM email_message WHERE message_id = %s",
            (payload.message_id,),
        )
        existing = cur.fetchone()
        if existing:
            return {
                "id": existing["id"],
                "duplicate": True,
                "tournament_id": existing["tournament_id"],
                "classification": existing["classification"],
                "status": existing["status"],
            }
        raise

    row = cur.fetchone()
    return {
        "id": row["id"],
        "duplicate": False,
        "tournament_id": row["tournament_id"],
        "classification": row["classification"],
        "status": row["status"],
        "message_id": row["message_id"],
    }
