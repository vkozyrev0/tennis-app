"""Persist derived email text fields (D9) — C2 split from routers/emails.py."""
import json

from .email_extract import compute_extracted_fields


def _stamp_extracted_fields(cur, email_id: int, subject, body, classification,
                            detected_player_id=None) -> dict:
    """Compute + persist derived text fields (D9). Returns the field dict."""
    fields = compute_extracted_fields(
        subject, body, classification,
        has_detected_player=bool(detected_player_id),
    )
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
            "detected_name_pairs": json.dumps(fields["detected_name_pairs"])
            if fields["detected_name_pairs"] is not None else None,
            "id": email_id,
        },
    )
    return fields


def _apply_extracted_to_row(r: dict, fields: dict) -> None:
    """Copy stamped fields onto a SELECT row (and drop the ready flag)."""
    for k, v in fields.items():
        r[k] = v
    r.pop("detected_text_ready", None)
