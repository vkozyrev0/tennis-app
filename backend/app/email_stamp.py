"""Persist derived email text fields (D9) — C2 split from routers/emails.py."""
import json
from datetime import date, datetime, timedelta

from .email_extract import compute_extracted_fields, infer_gender_from_email
from .inbox_person import upsert_inbox_people

# Date-only Mailbox pickers are calendar days; received_at is timestamptz UTC.
# US evening on the until day is already the next UTC date, so a strict
# end-of-until-day UTC cut misses the mail the Inbox is showing.
_DATE_TZ_SLACK = timedelta(hours=14)

_PAIR_CLASSES = frozenset({"doubles", "pairing_avoidance"})


def _pairs_json(pairs, classification):
    """JSONB payload. Empty doubles/pairing stores [] so GET will not restamp."""
    if pairs is None and classification in _PAIR_CLASSES:
        pairs = []
    return json.dumps(pairs) if pairs is not None else None


def _stamp_extracted_fields(cur, email_id: int, subject, body, classification,
                            detected_player_id=None) -> dict:
    """Compute + persist derived text fields (D9). Returns the field dict."""
    fields = compute_extracted_fields(
        subject, body, classification,
        has_detected_player=bool(detected_player_id),
    )
    if fields["detected_name_pairs"] is None and classification in _PAIR_CLASSES:
        fields["detected_name_pairs"] = []
    cur.execute(
        """
        UPDATE email_message SET
            detected_usta_text = %(detected_usta_text)s,
            detected_reason = %(detected_reason)s,
            detected_division = %(detected_division)s,
            detected_events = %(detected_events)s,
            detected_name_pairs = %(detected_name_pairs)s::jsonb,
            detected_avoid_day = %(detected_avoid_day)s,
            detected_avoid_time = %(detected_avoid_time)s,
            detected_text_ready = TRUE
        WHERE id = %(id)s
        """,
        {
            **fields,
            "detected_name_pairs": _pairs_json(
                fields["detected_name_pairs"], classification,
            ),
            "id": email_id,
        },
    )
    pairs = fields.get("detected_name_pairs") or []
    if pairs:
        upsert_inbox_people(
            cur, email_id, pairs, infer_gender_from_email(subject, body),
        )
    return fields


def _stamp_extracted_fields_with_leftover(
    cur, email_id: int, subject, body, classification, detected_player_id=None,
    *, force_leftover: bool = False,
) -> dict:
    """Stamp extractors, then leftover-LLM players if the pair list is still empty.

    ``force_leftover`` (date-range reprocess) runs leftover even when pairs
    already exist, so a changed leftover prompt can refill names.
    """
    fields = _stamp_extracted_fields(
        cur, email_id, subject, body, classification, detected_player_id,
    )
    pairs = fields.get("detected_name_pairs") or []
    if not force_leftover and (pairs or classification not in {
        "doubles", "withdrawal", "late_entry", "pairing_avoidance",
    }):
        return fields
    from .email_llm import leftover_model_intent, llm_enabled
    if not llm_enabled():
        return fields
    parsed = leftover_model_intent(subject, body)
    leftover = (parsed or {}).get("players") or []
    if not leftover:
        return fields
    from .email_extract import merge_leftover_players
    merged = merge_leftover_players(pairs, leftover)
    if not merged:
        return fields
    fields["detected_name_pairs"] = merged
    cur.execute(
        "UPDATE email_message SET detected_name_pairs = %s::jsonb WHERE id = %s",
        (json.dumps(merged), email_id),
    )
    upsert_inbox_people(
        cur, email_id, merged, infer_gender_from_email(subject, body),
    )
    return fields


def _apply_extracted_to_row(r: dict, fields: dict) -> None:
    """Copy stamped fields onto a SELECT row (and drop the ready flag)."""
    for k, v in fields.items():
        r[k] = v
    r.pop("detected_text_ready", None)


def reprocess_email(cur, email_id: int, *, use_leftover: bool = True) -> dict | None:
    """Re-run classify + leftover LLM on one stored email. No new row.

    Leftover is called even when the heuristic is not ``other`` (prompt change).
    Cache is bypassed so a new leftover prompt is not skipped.
    """
    import time as _time

    from .crypto import decrypt as _dec_body
    from .email_extract import merge_leftover_players
    from .email_llm import leftover_model_intent, llm_enabled
    from .triage import _classify_raw

    cur.execute(
        "SELECT id, subject, body, detected_player_id FROM email_message "
        "WHERE id = %s AND deleted_at IS NULL",
        (email_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    body = _dec_body(row.get("body"))
    t0 = _time.perf_counter()
    heuristic = _classify_raw(row.get("subject"), body)
    leftover_called = False
    leftover_hit = False
    parsed = None
    if use_leftover and llm_enabled():
        leftover_called = True
        parsed = leftover_model_intent(
            row.get("subject"), body, bypass_cache=True,
        )
        leftover_hit = parsed is not None
    cls = heuristic
    if parsed and float(parsed.get("confidence") or 0) >= 0.6:
        cls = parsed.get("intent") or heuristic
    ms = int((_time.perf_counter() - t0) * 1000)
    cur.execute(
        "UPDATE email_message SET classification = %s, classified_ms = %s "
        "WHERE id = %s",
        (cls, ms, email_id),
    )
    fields = _stamp_extracted_fields(
        cur, email_id, row.get("subject"), body, cls,
        row.get("detected_player_id"),
    )
    leftover_players = (parsed or {}).get("players") or []
    if leftover_players:
        merged = merge_leftover_players(
            fields.get("detected_name_pairs") or [], leftover_players,
        )
        if merged:
            fields["detected_name_pairs"] = merged
            cur.execute(
                "UPDATE email_message SET detected_name_pairs = %s::jsonb "
                "WHERE id = %s",
                (json.dumps(merged), email_id),
            )
            upsert_inbox_people(
                cur, email_id, merged,
                infer_gender_from_email(row.get("subject"), body),
            )
    return {
        "id": email_id,
        "classification": cls,
        "classified_ms": ms,
        "leftover_called": leftover_called,
        "leftover_hit": leftover_hit,
        "detected_name_pairs": fields.get("detected_name_pairs") or [],
    }


def _is_date_only(raw) -> bool:
    """True for a YYYY-MM-DD / date value (not a datetime)."""
    if raw is None or raw == "":
        return False
    if isinstance(raw, datetime):
        return False
    if isinstance(raw, date):
        return True
    s = str(raw).strip()
    return 1 <= len(s) <= 10


def list_window_ids(
    cur, tournament_id: int, since, until, *, get_all: bool = False,
) -> list[int]:
    """Ids of visible CourtOps copies in a received_at window.

    Inbox lists the whole tournament; the Mailbox picker is a fetch window.
    ``get_all`` matches the grid (every non-deleted copy). Date-only bounds
    get ±14h slack so a US-local picker day still includes mail whose UTC
    ``received_at`` landed on the next or previous calendar date.
    """
    from .inbox_feeds import as_window as _window

    if tournament_id is None:
        return []
    q = (
        "SELECT id FROM email_message WHERE tournament_id = %s "
        "AND deleted_at IS NULL"
    )
    params: list = [tournament_id]
    if not get_all:
        start, end = _window(since, until)
        if start is None and end is None:
            return []
        if start is not None:
            if _is_date_only(since):
                start = start - _DATE_TZ_SLACK
            q += " AND received_at >= %s"
            params.append(start)
        if end is not None:
            if _is_date_only(until):
                end = end + _DATE_TZ_SLACK
            q += " AND received_at <= %s"
            params.append(end)
    q += " ORDER BY id"
    cur.execute(q, params)
    return [r["id"] for r in (cur.fetchall() or [])]


def reprocess_window(cur, tournament_id: int, since, until) -> dict:
    """Re-stamp CourtOps copies in a received_at window. No duplicates."""
    ids = list_window_ids(cur, tournament_id, since, until)
    out = []
    for eid in ids:
        rec = reprocess_email(cur, eid)
        if rec:
            out.append(rec["id"])
    return {"reprocessed": len(out), "ids": out}
