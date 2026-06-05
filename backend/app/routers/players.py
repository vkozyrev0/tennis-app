from datetime import datetime

import psycopg
from fastapi import APIRouter, Depends, Header, HTTPException, Response

from ..db import db_dep
from ..models import PlayerCreate, PlayerHistoryOut, PlayerOut

router = APIRouter(prefix="/api/players", tags=["players"])


def _updated_at_matches(stored: datetime | None, seen_iso: str) -> bool:
    """Optimistic-concurrency check: does the client's `X-If-Updated-At` refer to
    the same instant as the row's current `updated_at`?

    Compares *parsed instants*, not raw strings. The API serializes `updated_at`
    through Pydantic, which renders a UTC datetime with a `Z` suffix
    (`…14.060123Z`), whereas psycopg's `datetime.isoformat()` uses `+00:00`
    (`…14.060123+00:00`). A naive string `!=` therefore NEVER matched for the
    UTC `timestamptz` column, so the *first* writer — sending back exactly the
    timestamp it just read — always got a spurious 409. Parsing both sides makes
    the comparison format-agnostic. (`fromisoformat` accepts `Z` on 3.11+; the
    explicit replace keeps it robust regardless of runtime.)
    """
    if stored is None:
        return True  # no stored timestamp ⇒ nothing to conflict against
    try:
        seen = datetime.fromisoformat(seen_iso.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return False  # unparseable header ⇒ treat as stale, force a reload
    return stored == seen

_COLS = (
    # B2a (migration 0028): expose the extended catalog fields the
    # "Full Player Data" import populates.
    "id, usta_number, first_name, last_name, gender, birthdate, "
    "birthdate_precision, city, state, district, section, "
    "emails, phones, wtn_singles, wtn_singles_conf, "
    "wtn_doubles, wtn_doubles_conf, updated_at"
)

# Audit F6: PlayerCreate is shared between POST and PUT bodies; the PUT path
# accepts spread `{**p, "city": "..."}` payloads that may carry id/updated_at,
# which Pydantic v2 silently ignores (default `extra="ignore"`). This is
# intentional — if anyone tightens to `extra="forbid"` later, every Setup PUT
# test breaks and the test naming becomes the contract.


@router.get("", response_model=list[PlayerOut])
def list_players(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM player ORDER BY last_name, first_name")
        return cur.fetchall()


@router.get("/{player_id}", response_model=PlayerOut)
def get_player(player_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM player WHERE id = %s", (player_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="player not found")
    return row


@router.get("/{player_id}/history", response_model=list[PlayerHistoryOut])
def player_history(player_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, player_id, usta_number, first_name, last_name, birthdate,
                   valid_from, valid_to, change_type
            FROM player_history WHERE player_id = %s ORDER BY valid_from DESC
            """,
            (player_id,),
        )
        return cur.fetchall()


@router.post("", response_model=PlayerOut, status_code=201)
def create_player(body: PlayerCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO player (usta_number, first_name, last_name, gender, birthdate, city, state)
                VALUES (%(usta_number)s, %(first_name)s, %(last_name)s, %(gender)s,
                        %(birthdate)s, %(city)s, %(state)s)
                RETURNING {_COLS}
                """,
                body.model_dump(),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="usta_number already exists")


@router.put("/{player_id}", response_model=PlayerOut)
def update_player(
    player_id: int,
    body: PlayerCreate,
    conn=Depends(db_dep),
    x_if_updated_at: str | None = Header(default=None, alias="X-If-Updated-At"),
):
    """Audit M19 + F5: optimistic concurrency via a custom `X-If-Updated-At`
    header carrying the ISO `updated_at` the client last saw. We switched
    away from `If-Unmodified-Since` because RFC 7232 defines that as an
    HTTP-date (RFC 1123); some proxies and WAFs reject ISO 8601 values, so
    a custom header is the portable choice. The header is optional —
    callers that don't care skip the check.

    The player_history trigger snapshots the prior values and bumps updated_at.
    """
    try:
        with conn.cursor() as cur:
            if x_if_updated_at:
                cur.execute(
                    "SELECT updated_at FROM player WHERE id = %s", (player_id,)
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="player not found")
                if not _updated_at_matches(row["updated_at"], x_if_updated_at):
                    raise HTTPException(
                        status_code=409,
                        detail="player was modified elsewhere — reload and try again",
                    )
            cur.execute(
                f"""
                UPDATE player SET
                    usta_number = %(usta_number)s,
                    first_name = %(first_name)s,
                    last_name = %(last_name)s,
                    gender = %(gender)s,
                    birthdate = %(birthdate)s,
                    city = %(city)s,
                    state = %(state)s,
                    -- Audit M19: bump updated_at on every PUT so optimistic
                    -- concurrency works even for non-history-tracked fields
                    -- (the player_history trigger only records *name* changes).
                    updated_at = now()
                WHERE id = %(id)s
                RETURNING {_COLS}
                """,
                {**body.model_dump(), "id": player_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="usta_number already exists")
    if row is None:
        raise HTTPException(status_code=404, detail="player not found")
    return row


@router.delete("/{player_id}", status_code=204)
def delete_player(player_id: int, conn=Depends(db_dep)):
    """Delete a player and ERASE their PII from the append-only history.

    `player_history` intentionally has no FK (audit rows outlive the record) and
    the delete trigger writes a final snapshot — so without this step a 'deleted'
    minor's name / USTA # / birthdate would persist there indefinitely, defeating
    retention/erasure (COPPA §312.10, PII-hardening H3). We keep the audit rows
    (player_id + change_type + timestamps) but null the PII columns: the record
    is erased while the tamper-evident audit skeleton survives. Roster + Part B
    rows cascade via FKs; email links are SET NULL.
    """
    with conn.cursor() as cur:
        cur.execute("DELETE FROM player WHERE id = %s", (player_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="player not found")
        # Runs AFTER the delete so the trigger's freshly-inserted 'delete' row is
        # redacted too.
        cur.execute(
            "UPDATE player_history SET usta_number = NULL, first_name = NULL, "
            "last_name = NULL, birthdate = NULL WHERE player_id = %s",
            (player_id,),
        )
    return Response(status_code=204)
