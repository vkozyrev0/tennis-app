"""Shared helpers for Part B list filing."""


def upsert_player(cur, usta_number, first_name, last_name) -> int:
    """Find a player by USTA number (updating name if given) or create them."""
    cur.execute("SELECT id FROM player WHERE usta_number = %s", (usta_number,))
    p = cur.fetchone()
    if p:
        pid = p["id"]
        if first_name or last_name:
            cur.execute(
                "UPDATE player SET first_name = COALESCE(%s, first_name), "
                "last_name = COALESCE(%s, last_name) WHERE id = %s",
                (first_name, last_name, pid),
            )
        return pid
    cur.execute(
        "INSERT INTO player (usta_number, first_name, last_name) VALUES (%s,%s,%s) RETURNING id",
        (usta_number, first_name, last_name),
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
