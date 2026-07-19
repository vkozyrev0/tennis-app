import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import SiteIds, SiteOut, TournamentCreate, TournamentOut

router = APIRouter(prefix="/api/tournaments", tags=["tournaments"])

_COLS = (
    "id, name, type, play_start_date, play_end_date, "
    "registration_deadline, late_entry_deadline, ingest_address"
)
_SITE_COLS = "id, code, name, street, city, state, zip, lat, lng"


@router.get("", response_model=list[TournamentOut])
def list_tournaments(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        # Soft-deleted (trashed) tournaments are hidden here (and from the active
        # picker that reads this); they live in /api/trash until restored/purged.
        cur.execute(f"SELECT {_COLS} FROM tournament WHERE deleted_at IS NULL ORDER BY id")
        return cur.fetchall()


@router.get("/{tournament_id}", response_model=TournamentOut)
def get_tournament(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} FROM tournament WHERE id = %s", (tournament_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="tournament not found")
    return row


def _tournament_params(body: TournamentCreate) -> dict:
    """Normalize optional ingest_address (blank → NULL; lowercased for stable match)."""
    data = body.model_dump()
    addr = data.get("ingest_address")
    if addr is not None:
        addr = str(addr).strip().lower() or None
    data["ingest_address"] = addr
    return data


def _unique_detail(exc: psycopg.errors.UniqueViolation) -> str:
    diag = getattr(exc, "diag", None)
    cname = (getattr(diag, "constraint_name", None) or "") if diag else ""
    if "ingest_address" in cname:
        return "another active tournament already uses this ingest address"
    return "tournament name already exists"


@router.post("", response_model=TournamentOut, status_code=201)
def create_tournament(body: TournamentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO tournament
                    (name, type, play_start_date, play_end_date,
                     registration_deadline, late_entry_deadline, ingest_address)
                VALUES
                    (%(name)s, %(type)s, %(play_start_date)s, %(play_end_date)s,
                     %(registration_deadline)s, %(late_entry_deadline)s,
                     %(ingest_address)s)
                RETURNING {_COLS}
                """,
                _tournament_params(body),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation as e:
        raise HTTPException(status_code=409, detail=_unique_detail(e))


@router.put("/{tournament_id}", response_model=TournamentOut)
def update_tournament(tournament_id: int, body: TournamentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE tournament SET
                    name = %(name)s, type = %(type)s,
                    play_start_date = %(play_start_date)s,
                    play_end_date = %(play_end_date)s,
                    registration_deadline = %(registration_deadline)s,
                    late_entry_deadline = %(late_entry_deadline)s,
                    ingest_address = %(ingest_address)s
                WHERE id = %(id)s
                RETURNING {_COLS}
                """,
                {**_tournament_params(body), "id": tournament_id},
            )
            row = cur.fetchone()
    except psycopg.errors.UniqueViolation as e:
        raise HTTPException(status_code=409, detail=_unique_detail(e))
    if row is None:
        raise HTTPException(status_code=404, detail="tournament not found")
    return row


@router.delete("/{tournament_id}", status_code=204)
def delete_tournament(tournament_id: int, conn=Depends(db_dep)):
    """Soft-delete (P2 #13): flag deleted_at instead of cascading the whole
    event away. Hidden from the lists; restore from Trash. A second delete of an
    already-trashed tournament 404s (it's no longer in the active set)."""
    with conn.cursor() as cur:
        cur.execute("UPDATE tournament SET deleted_at = now() "
                    "WHERE id = %s AND deleted_at IS NULL", (tournament_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="tournament not found")
    return Response(status_code=204)


@router.post("/{tournament_id}/restore", response_model=TournamentOut)
def restore_tournament(tournament_id: int, conn=Depends(db_dep)):
    """Undo a soft-delete — bring a trashed tournament (and all the roster /
    assignments / emails that were preserved with it) back into the active set."""
    with conn.cursor() as cur:
        cur.execute("UPDATE tournament SET deleted_at = NULL "
                    "WHERE id = %s AND deleted_at IS NOT NULL", (tournament_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="no trashed tournament with that id")
        cur.execute(f"SELECT {_COLS} FROM tournament WHERE id = %s", (tournament_id,))
        return cur.fetchone()


# ---------- Tournament <-> Site (M2M) ----------
@router.get("/{tournament_id}/sites", response_model=list[SiteOut])
def list_tournament_sites(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {", ".join("s." + c for c in _SITE_COLS.split(", "))}
            FROM tournament_site ts JOIN site s ON s.id = ts.site_id
            WHERE ts.tournament_id = %s ORDER BY s.id
            """,
            (tournament_id,),
        )
        return cur.fetchall()


@router.put("/{tournament_id}/sites", response_model=list[SiteOut])
def set_tournament_sites(tournament_id: int, body: SiteIds, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute("DELETE FROM tournament_site WHERE tournament_id = %s", (tournament_id,))
        for sid in dict.fromkeys(body.site_ids):  # de-dup, preserve order
            try:
                cur.execute(
                    "INSERT INTO tournament_site (tournament_id, site_id) VALUES (%s, %s)",
                    (tournament_id, sid),
                )
            except psycopg.errors.ForeignKeyViolation:
                raise HTTPException(status_code=400, detail=f"site_id {sid} does not exist")
    return list_tournament_sites(tournament_id, conn)


# ---------- B1: Division ↔ site assignment (per tournament) ----------
# Returns the full matrix in one shot: every division that COULD be used at
# this tournament + the assigned site_id (or null for unassigned). The
# frontend renders this as a toggle table on Tournament → Sites.
@router.get("/{tournament_id}/site-divisions")
def list_tournament_site_divisions(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        # Join over LEFT to surface every division — even unassigned ones —
        # so the UI can render a row per division and pick a site for it.
        cur.execute(
            """
            SELECT d.id AS division_id, d.code, d.label, d.tournament_type,
                   tsd.site_id
              FROM division d
              LEFT JOIN tournament_site_division tsd
                ON tsd.division_id = d.id AND tsd.tournament_id = %s
              ORDER BY d.sort_order, d.code
            """,
            (tournament_id,),
        )
        return cur.fetchall()


class _SiteDivisionBody(__import__("pydantic").BaseModel):
    site_id: int | None = None  # null clears the assignment


@router.put("/{tournament_id}/site-divisions/{division_id}")
def set_tournament_site_division(
    tournament_id: int, division_id: int,
    body: _SiteDivisionBody, conn=Depends(db_dep),
):
    """Set (or clear) which site a division is assigned to for this
    tournament. site_id=None clears the row. A division can only be at one
    site (questionnaire 1.1); ON CONFLICT preserves that 1-to-1 invariant."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute("SELECT 1 FROM division WHERE id = %s", (division_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="division not found")
        if body.site_id is None:
            cur.execute(
                "DELETE FROM tournament_site_division "
                "WHERE tournament_id = %s AND division_id = %s",
                (tournament_id, division_id),
            )
            return {"tournament_id": tournament_id, "division_id": division_id,
                    "site_id": None}
        # Site must already be linked to this tournament — keeps the two
        # M2M tables in sync (you can't park a division at a site the
        # tournament doesn't use).
        cur.execute(
            "SELECT 1 FROM tournament_site "
            "WHERE tournament_id = %s AND site_id = %s",
            (tournament_id, body.site_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(
                status_code=400,
                detail=f"site_id {body.site_id} isn't a site for this tournament",
            )
        cur.execute(
            """
            INSERT INTO tournament_site_division (tournament_id, site_id, division_id)
            VALUES (%s, %s, %s)
            ON CONFLICT (tournament_id, division_id) DO UPDATE SET
              site_id = EXCLUDED.site_id
            """,
            (tournament_id, body.site_id, division_id),
        )
        return {"tournament_id": tournament_id, "division_id": division_id,
                "site_id": body.site_id}


# ---------- B1: T-shirts grouped by site (per tournament) ----------
# Drives the multi-site t-shirt report: one row per selected roster entry
# with the division's assigned site name folded in. Players whose division
# has no site assigned land in an "Unassigned" bucket (questionnaire 1.5).
@router.get("/{tournament_id}/tshirts-by-site")
def tshirts_by_site(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            """
            SELECT p.usta_number,
                   COALESCE(p.first_name, '') AS first_name,
                   COALESCE(p.last_name, '')  AS last_name,
                   e.age_division,
                   e.t_shirt_size,
                   COALESCE(s.name, 'Unassigned') AS site_name,
                   s.id AS site_id
              FROM tournament_entry e
              JOIN player p ON p.id = e.player_id
              -- Look up the division row by code, then its site assignment.
              LEFT JOIN division d        ON d.code = e.age_division
              LEFT JOIN tournament_site_division tsd
                ON tsd.tournament_id = e.tournament_id
               AND tsd.division_id   = d.id
              LEFT JOIN site s            ON s.id  = tsd.site_id
             WHERE e.tournament_id = %s
               AND e.selection_status = 'selected'
               AND e.t_shirt_size IS NOT NULL
             ORDER BY site_name, e.age_division, p.last_name, p.first_name
            """,
            (tournament_id,),
        )
        return cur.fetchall()
