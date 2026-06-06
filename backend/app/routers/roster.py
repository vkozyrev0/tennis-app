"""Tournament <-> Player roster (tournament_entry) + CSV/XLSX direct-merge import.

The direct-merge endpoint here and the staged importer in `importer.py` share a
single source of truth: header aliases, parse/validate, and the merge function
all live in `importer.py`. This file owns the *immediate-write* UX (no staging
review) for the TD's official USTA roster upload, plus the regular CRUD."""
import psycopg
from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile

from .. import importer
from ..db import db_dep
from ..models import RosterEntryCreate, RosterEntryOut
from ..playerops import upsert_player
from ..shirtops import norm_shirt as _norm_shirt

router = APIRouter(tags=["roster"])


@router.post("/api/tournaments/{tournament_id}/players/import")
async def import_roster(tournament_id: int, file: UploadFile = File(...), conn=Depends(db_dep)):
    """Upload a CSV/XLSX roster; upsert players (by USTA #) and their entries.

    Audit (import/export #1): consolidated on `importer.parse_file` +
    `importer._merge_roster` so this path can't drift from the staged importer
    on header aliases, the gender pre-check, or shirt normalization. The
    response shape is preserved for the existing frontend.
    """
    cfg = importer.TYPES["roster"]
    records = importer.parse_file(file.filename, await file.read(), cfg["cols"])
    created = updated = upserted = 0
    errors: list[str] = []
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        for rec in records:
            row_num = rec["row_num"] + 1  # +1 to count the header row, matching the old wording
            err = importer.validate(rec["data"], cfg["cols"], cur)
            if err:
                errors.append(f"row {row_num}: {err}")
                continue
            cur.execute("SAVEPOINT row")
            try:
                cur.execute("SELECT 1 FROM player WHERE usta_number = %s",
                            (rec["data"]["usta_number"],))
                existed = cur.fetchone() is not None
                cfg["merge"](cur, tournament_id, rec["data"])
                cur.execute("RELEASE SAVEPOINT row")
                if existed:
                    updated += 1
                else:
                    created += 1
                upserted += 1
            except HTTPException as e:
                cur.execute("ROLLBACK TO SAVEPOINT row")
                errors.append(f"row {row_num}: {e.detail}")
    return {"created_players": created, "updated_players": updated,
            "entries": upserted, "errors": errors}


# Names are resolved POINT-IN-TIME: the version of the player's name valid as of
# the tournament's play_start_date (policy A). Falls back to the current name when
# the tournament predates any recorded version. See docs/data-model.md §PlayerHistory.
_SELECT = """
SELECT e.id, e.tournament_id, e.player_id, e.age_division, e.events,
       e.selection_status, e.t_shirt_size, e.dietary_preference,
       -- B2a (migration 0028) payment snapshot from Full Player Data import.
       e.payment_status, e.amount_paid, e.amount_refunded,
       e.amount_due, e.amount_outstanding, e.card_stored,
       -- B2b correction-import fields (still populated by B2a if present).
       e.signed_in, e.suspension_points,
       -- B3 combined-import lodging fields (canonical + raw fallback).
       e.lodging_plan, e.lodging_plan_raw,
       p.usta_number,
       COALESCE(nm.first_name, p.first_name) AS first_name,
       COALESCE(nm.last_name,  p.last_name)  AS last_name
FROM tournament_entry e
JOIN tournament t ON t.id = e.tournament_id
JOIN player p ON p.id = e.player_id
LEFT JOIN LATERAL (
    SELECT first_name, last_name
    FROM (
        SELECT first_name, last_name, valid_from
        FROM player_history WHERE player_id = e.player_id
        UNION ALL
        SELECT first_name, last_name, updated_at FROM player WHERE id = e.player_id
    ) v
    WHERE v.valid_from <= t.play_start_date::timestamptz
    ORDER BY v.valid_from DESC
    LIMIT 1
) nm ON true
"""


@router.get("/api/tournaments/{tournament_id}/players", response_model=list[RosterEntryOut])
def list_roster(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_SELECT + " WHERE e.tournament_id = %s ORDER BY p.last_name, p.first_name",
                    (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/players",
             response_model=RosterEntryOut, status_code=201)
def add_roster_entry(tournament_id: int, body: RosterEntryCreate, conn=Depends(db_dep)):
    body.t_shirt_size = _norm_shirt(body.t_shirt_size)  # canonical size (DB CHECK)
    try:
        with conn.cursor() as cur:
            # Inline-create the player if the form sent a USTA # but no player_id —
            # lets a TD add a walk-in directly from the Roster form.
            pid = body.player_id
            if pid is None:
                pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name, body.gender)
            cur.execute(
                """
                INSERT INTO tournament_entry
                    (tournament_id, player_id, age_division, events,
                     selection_status, t_shirt_size, dietary_preference)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (tournament_id, pid, body.age_division, body.events,
                 body.selection_status, body.t_shirt_size, body.dietary_preference),
            )
            new_id = cur.fetchone()["id"]
            cur.execute(_SELECT + " WHERE e.id = %s", (new_id,))
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="player already on this tournament roster")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="tournament_id or player_id does not exist")
    except psycopg.errors.CheckViolation as e:
        raise HTTPException(status_code=400, detail=f"invalid value: {e.diag.constraint_name or 'check failed'}")


@router.put("/api/roster/{entry_id}", response_model=RosterEntryOut)
def update_roster_entry(entry_id: int, body: RosterEntryCreate, conn=Depends(db_dep)):
    body.t_shirt_size = _norm_shirt(body.t_shirt_size)  # canonical size (DB CHECK)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE tournament_entry SET
                    player_id = %(player_id)s, age_division = %(age_division)s,
                    events = %(events)s, selection_status = %(selection_status)s,
                    t_shirt_size = %(t_shirt_size)s, dietary_preference = %(dietary_preference)s,
                    -- B3: TD can upgrade an unmapped raw answer to canonical
                    -- by editing the Lodging cell in the roster grid. PUT
                    -- only touches lodging_plan; lodging_plan_raw is preserved.
                    lodging_plan = %(lodging_plan)s
                WHERE id = %(id)s
                RETURNING id
                """,
                {**body.model_dump(), "id": entry_id},
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="roster entry not found")
            cur.execute(_SELECT + " WHERE e.id = %s", (entry_id,))
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="player already on this tournament roster")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="player_id does not exist")
    except psycopg.errors.CheckViolation as e:
        raise HTTPException(status_code=400, detail=f"invalid value: {e.diag.constraint_name or 'check failed'}")


@router.delete("/api/roster/{entry_id}", status_code=204)
def delete_roster_entry(entry_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM tournament_entry WHERE id = %s", (entry_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="roster entry not found")
    return Response(status_code=204)


@router.post("/api/roster/{entry_id}/promote", response_model=RosterEntryOut)
def promote_alternate(entry_id: int, conn=Depends(db_dep)):
    """Promote an alternate to selected (the standard move when a selected player
    withdraws and a slot opens). Only an *alternate* can be promoted — promoting a
    selected entry is a no-op error, and a withdrawn one is rejected so a
    withdrawal isn't silently reversed."""
    with conn.cursor() as cur:
        cur.execute("SELECT selection_status FROM tournament_entry WHERE id = %s", (entry_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="roster entry not found")
        if row["selection_status"] != "alternate":
            raise HTTPException(
                status_code=400,
                detail=f"only an alternate can be promoted (this entry is {row['selection_status']})",
            )
        cur.execute(
            "UPDATE tournament_entry SET selection_status = 'selected' WHERE id = %s",
            (entry_id,),
        )
        cur.execute(_SELECT + " WHERE e.id = %s", (entry_id,))
        return cur.fetchone()
