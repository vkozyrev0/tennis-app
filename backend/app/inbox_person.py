"""Inbox-parallel name+USTA people list (not Setup Players / not roster)."""
from fastapi import HTTPException

from .playerops import norm_gender, upsert_player

_COLS = (
    "id, name, first_name, last_name, usta_number, gender, "
    "source_email_id, promoted_player_id, created_at"
)


def split_name(name: str | None) -> tuple[str | None, str | None]:
    s = " ".join((name or "").split())
    if not s:
        return None, None
    if "," in s:
        last, first = s.split(",", 1)
        last, first = last.strip() or None, first.strip() or None
        return first, last
    parts = s.split()
    if len(parts) == 1:
        return parts[0], None
    return parts[0], " ".join(parts[1:])


def _digits(usta) -> str | None:
    s = "".join(c for c in str(usta or "") if c.isdigit())
    return s or None


def _as_out(row: dict) -> dict:
    d = dict(row)
    d["player_id"] = d.get("promoted_player_id")
    return d


def upsert_inbox_people(cur, email_id, pairs, gender=None) -> list[dict]:
    """Insert or update inbox_person rows from extracted {name, usta} pairs."""
    if not pairs:
        return []
    g = norm_gender(gender)
    out: list[dict] = []
    for p in pairs:
        if not isinstance(p, dict):
            continue
        name = " ".join(str(p.get("name") or "").split()) or None
        usta = _digits(p.get("usta") or p.get("usta_number"))
        if not name and not usta:
            continue
        first, last = split_name(name)
        row = None
        if usta:
            cur.execute(f"SELECT {_COLS} FROM inbox_person WHERE usta_number = %s", (usta,))
            row = cur.fetchone()
        if row is None and name:
            cur.execute(
                f"SELECT {_COLS} FROM inbox_person "
                "WHERE usta_number IS NULL AND lower(name) = lower(%s)",
                (name,),
            )
            row = cur.fetchone()
        if row:
            cur.execute(
                f"""
                UPDATE inbox_person SET
                    name = COALESCE(%s, name),
                    first_name = COALESCE(%s, first_name),
                    last_name = COALESCE(%s, last_name),
                    usta_number = COALESCE(%s, usta_number),
                    gender = COALESCE(gender, %s),
                    source_email_id = COALESCE(%s, source_email_id)
                WHERE id = %s
                RETURNING {_COLS}
                """,
                (name, first, last, usta, g, email_id, row["id"]),
            )
        else:
            cur.execute(
                f"""
                INSERT INTO inbox_person
                    (name, first_name, last_name, usta_number, gender, source_email_id)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING {_COLS}
                """,
                (name or usta, first, last, usta, g, email_id),
            )
        out.append(_as_out(cur.fetchone()))
    return out


def list_inbox_people(cur) -> list[dict]:
    cur.execute(f"SELECT {_COLS} FROM inbox_person ORDER BY lower(name), id")
    return [_as_out(r) for r in cur.fetchall()]


def get_inbox_person(cur, person_id: int) -> dict | None:
    cur.execute(f"SELECT {_COLS} FROM inbox_person WHERE id = %s", (person_id,))
    row = cur.fetchone()
    return _as_out(row) if row else None


def promote_inbox_person(cur, person_id: int, *, gender=None, usta_number=None) -> dict:
    row = get_inbox_person(cur, person_id)
    if row is None:
        raise HTTPException(status_code=404, detail="inbox person not found")
    usta = _digits(usta_number) or _digits(row.get("usta_number"))
    if not usta:
        raise HTTPException(
            status_code=400,
            detail="USTA number is required to add this person to Players",
        )
    g = norm_gender(gender) or norm_gender(row.get("gender"))
    if not g:
        raise HTTPException(
            status_code=400,
            detail="gender is required to add this person to Players",
        )
    first = row.get("first_name")
    last = row.get("last_name")
    if not first and not last:
        first, last = split_name(row.get("name"))
    pid = upsert_player(cur, usta, first, last, g)
    cur.execute(
        f"""
        UPDATE inbox_person SET
            promoted_player_id = %s,
            usta_number = COALESCE(usta_number, %s),
            gender = COALESCE(gender, %s)
        WHERE id = %s
        RETURNING {_COLS}
        """,
        (pid, usta, g, person_id),
    )
    out = _as_out(cur.fetchone())
    out["player_id"] = pid
    return out
