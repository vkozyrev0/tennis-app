"""Shared helpers for Part B list filing."""
from fastapi import HTTPException


def norm_gender(v):
    """Normalize free-text gender to 'male'/'female'; return None on missing/
    unknown. Audit F14: moved here from `importer.py` so it sits in a leaf
    module — both roster.py and importer.py import from here, avoiding a
    cross-router cycle if importer.py later wants to use anything roster owns.
    """
    if v is None:
        return None
    s = str(v).strip().lower()
    if s in {"m", "male", "boy", "b", "man"}:
        return "male"
    if s in {"f", "female", "girl", "g", "woman", "w"}:
        return "female"
    return None


def upsert_player(cur, usta_number, first_name, last_name, gender=None) -> int:
    """Find a player by USTA number (updating name/gender if given) or create them.

    Audit N1: when creating a brand-new player we must NOT silently default
    gender to 'female' — that corrupted gender-aware division filtering for
    every boys' inbox flow. Callers that don't carry gender must catch the
    `gender required` error and surface it to the TD. The DB column stays
    NOT NULL (migration 0026); the helper just refuses to invent a value.
    """
    cur.execute("SELECT id FROM player WHERE usta_number = %s", (usta_number,))
    p = cur.fetchone()
    if p:
        pid = p["id"]
        if first_name or last_name or gender:
            cur.execute(
                "UPDATE player SET first_name = COALESCE(%s, first_name), "
                "last_name = COALESCE(%s, last_name), gender = COALESCE(%s, gender) "
                "WHERE id = %s",
                (first_name, last_name, gender, pid),
            )
        return pid
    if not gender:
        # Surface a 400 instead of a 500 so Part B file flows get a clear
        # "add the player in Setup first" message rather than a stack trace.
        raise HTTPException(
            status_code=400,
            detail=f"player {usta_number} isn't in Setup → Players yet — add them there first (gender is required)",
        )
    cur.execute(
        "INSERT INTO player (usta_number, first_name, last_name, gender) VALUES (%s,%s,%s,%s) RETURNING id",
        (usta_number, first_name, last_name, gender),
    )
    return cur.fetchone()["id"]


def upsert_hotel(cur, name):
    """Find a hotel by (case-insensitive, whitespace-collapsed) name or create it.
    Returns (hotel_id, canonical_name) — or (None, None) for a blank name."""
    n = " ".join((name or "").split())
    if not n:
        return None, None
    cur.execute("SELECT id, name FROM hotel WHERE lower(name) = lower(%s) LIMIT 1", (n,))
    row = cur.fetchone()
    if row:
        return row["id"], row["name"]
    cur.execute("INSERT INTO hotel (name) VALUES (%s) RETURNING id, name", (n,))
    r = cur.fetchone()
    return r["id"], r["name"]


def mark_email_filed(cur, email_id, classification) -> None:
    if email_id:
        cur.execute(
            "UPDATE email_message SET status = 'filed', classification = %s WHERE id = %s",
            (classification, email_id),
        )
