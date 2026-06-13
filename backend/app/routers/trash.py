"""Trash view (P2 #13): the soft-deleted rows, for review + restore.

Restore itself lives on each entity's own router (POST .../restore); this just
gathers what's currently trashed so the UI can list it in one place. Scoped to
the soft-deletable entities — tournaments and day-of incidents.
"""
from fastapi import APIRouter, Depends

from ..db import db_dep

router = APIRouter(tags=["trash"])


@router.get("/api/trash")
def list_trash(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, type, play_start_date, play_end_date, deleted_at "
            "FROM tournament WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
        )
        tournaments = cur.fetchall()
        cur.execute(
            "SELECT i.id, i.tournament_id, t.name AS tournament_name, i.category, "
            "       i.severity, i.description, i.occurred_at, i.deleted_at "
            "FROM tournament_incident i JOIN tournament t ON t.id = i.tournament_id "
            "WHERE i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC"
        )
        incidents = cur.fetchall()
    return {"tournaments": tournaments, "incidents": incidents}
