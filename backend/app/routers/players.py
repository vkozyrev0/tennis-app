from datetime import datetime

import psycopg
from fastapi import APIRouter, Depends, Header, HTTPException, Response

from ..crypto import decrypt as _dec_pii
from ..crypto import encrypt as _enc_pii
from ..db import db_dep
from ..models import PlayerCreate, PlayerHistoryOut, PlayerOut

router = APIRouter(prefix="/api/players", tags=["players"])


def _enc_birthdate(d) -> str | None:
    """Encrypt a date/None for the (now text) birthdate column (PII H2)."""
    if d is None:
        return None
    return _enc_pii(d.isoformat() if hasattr(d, "isoformat") else str(d))


def _decrypt_contact(row: dict) -> dict:
    """Decrypt the at-rest-encrypted PII fields (contact + birthdate, PII H2).
    Passes through legacy plaintext (see app/crypto.py); the decrypted birthdate
    is an ISO date string that Pydantic re-parses to a date in PlayerOut."""
    if row is not None:
        row["emails"] = _dec_pii(row.get("emails"))
        row["phones"] = _dec_pii(row.get("phones"))
        row["birthdate"] = _dec_pii(row.get("birthdate"))
    return row


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
        return [_decrypt_contact(r) for r in cur.fetchall()]


@router.get("/{player_id}", response_model=PlayerOut)
def get_player(player_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM player WHERE id = %s", (player_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="player not found")
    return _decrypt_contact(row)


@router.get("/{player_id}/overview")
def player_overview(player_id: int, tournament_id: int | None = None, conn=Depends(db_dep)):
    """Player 360 — everything the TD needs about one player in one place: their
    core identity, every tournament they're entered in (status + division), and —
    scoped to `tournament_id` when given — their filed requests across all the
    Part B lists. Siloed-by-tab data unified by USTA #."""
    def _tclause():
        return (" AND tournament_id = %s", [player_id, tournament_id]) if tournament_id \
            else ("", [player_id])
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, usta_number, first_name, last_name, gender, city, state "
            "FROM player WHERE id = %s",
            (player_id,),
        )
        player = cur.fetchone()
        if player is None:
            raise HTTPException(status_code=404, detail="player not found")

        # Every tournament this player is entered in (cross-tournament context).
        cur.execute(
            "SELECT e.tournament_id, t.name AS tournament_name, e.selection_status, "
            "       e.age_division, e.t_shirt_size, e.dietary_preference, e.lodging_plan "
            "FROM tournament_entry e JOIN tournament t ON t.id = e.tournament_id "
            "WHERE e.player_id = %s ORDER BY t.play_start_date DESC",
            (player_id,),
        )
        entries = cur.fetchall()

        clause, params = _tclause()
        reqs: dict = {}
        for key, sql in (
            ("late_entries", "SELECT id, tournament_id, age_division, events, request_date FROM late_entry WHERE player_id = %s" + clause),
            ("withdrawals", "SELECT id, tournament_id, events, reason, was_alternate FROM withdrawal WHERE player_id = %s" + clause),
            ("scheduling", "SELECT id, tournament_id, avoid_day, avoid_time_range FROM scheduling_avoidance WHERE player_id = %s" + clause),
            ("division_flex", "SELECT id, tournament_id, home_division, willing_divisions FROM division_flexibility WHERE player_id = %s" + clause),
            ("hotels", "SELECT id, tournament_id, hotel_name, lodging_plan FROM player_hotel_stay WHERE player_id = %s" + clause),
            ("doubles", "SELECT id, tournament_id, age_division, partner_usta, wants_random, status FROM doubles_request WHERE player_id = %s" + clause),
        ):
            cur.execute(sql, params)
            rows = cur.fetchall()
            for r in rows:
                if r.get("request_date"):
                    r["request_date"] = r["request_date"].isoformat()
            reqs[key] = rows

        # Pairing avoidances are group-based — find groups this player is a member of.
        pclause, pparams = (" AND pa.tournament_id = %s", [player_id, tournament_id]) if tournament_id \
            else ("", [player_id])
        cur.execute(
            "SELECT pa.id, pa.tournament_id, pa.age_division, pa.relationship "
            "FROM pairing_avoidance pa "
            "JOIN pairing_avoidance_member m ON m.pairing_avoidance_id = pa.id "
            "WHERE m.player_id = %s" + pclause,
            pparams,
        )
        reqs["pairing"] = cur.fetchall()

    return {"player": player, "tournament_id": tournament_id,
            "entries": entries, "requests": reqs}


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
        rows = cur.fetchall()
    for r in rows:                          # decrypt the at-rest birthdate (PII H2)
        r["birthdate"] = _dec_pii(r.get("birthdate"))
    return rows


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
                {**body.model_dump(), "birthdate": _enc_birthdate(body.birthdate)},
            )
            return _decrypt_contact(cur.fetchone())
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
                {**body.model_dump(), "birthdate": _enc_birthdate(body.birthdate),
                 "id": player_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="usta_number already exists")
    if row is None:
        raise HTTPException(status_code=404, detail="player not found")
    return _decrypt_contact(row)


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
