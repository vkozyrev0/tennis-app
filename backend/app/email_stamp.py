"""Persist derived email text fields (D9) — C2 split from routers/emails.py."""
import json

from .email_extract import compute_extracted_fields, infer_gender_from_email
from .inbox_person import upsert_inbox_people

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
) -> dict:
    """Stamp extractors, then leftover-LLM players if the pair list is still empty."""
    fields = _stamp_extracted_fields(
        cur, email_id, subject, body, classification, detected_player_id,
    )
    pairs = fields.get("detected_name_pairs") or []
    if pairs or classification not in {
        "doubles", "withdrawal", "late_entry", "pairing_avoidance",
    }:
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
