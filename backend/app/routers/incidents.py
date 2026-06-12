"""Day-of incident log (P4-3): the tournament's operational memory.

Weather delays, injuries, disputes, facility problems — logged as one-liners
while the event runs, optionally resolved later. Feeds post-event review and
the paper trail for protests/disputes. Tournament-scoped like staff/Part B.
"""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import IncidentCreate, IncidentOut, IncidentUpdate

router = APIRouter(tags=["incidents"])

_SELECT = (
    "SELECT i.id, i.tournament_id, i.site_id, COALESCE(s.code, s.name) AS site_label, "
    "       i.occurred_at, i.category, i.severity, i.description, "
    "       i.resolved, i.resolution, i.created_at "
    "FROM tournament_incident i LEFT JOIN site s ON s.id = i.site_id"
)


def _tournament_or_404(cur, tournament_id: int) -> None:
    cur.execute("SELECT 1 FROM tournament WHERE id = %s", (tournament_id,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="tournament not found")


@router.get("/api/tournaments/{tournament_id}/incidents", response_model=list[IncidentOut])
def list_incidents(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _tournament_or_404(cur, tournament_id)
        cur.execute(_SELECT + " WHERE i.tournament_id = %s "
                    "ORDER BY i.resolved, i.occurred_at DESC", (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/incidents",
             response_model=IncidentOut, status_code=201)
def create_incident(tournament_id: int, body: IncidentCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _tournament_or_404(cur, tournament_id)
        cur.execute(
            "INSERT INTO tournament_incident "
            "  (tournament_id, site_id, occurred_at, category, severity, description) "
            "VALUES (%s, %s, COALESCE(%s, now()), %s, %s, %s) RETURNING id",
            (tournament_id, body.site_id, body.occurred_at, body.category,
             body.severity, body.description),
        )
        new_id = cur.fetchone()["id"]
        cur.execute(_SELECT + " WHERE i.id = %s", (new_id,))
        return cur.fetchone()


@router.put("/api/incidents/{incident_id}", response_model=IncidentOut)
def update_incident(incident_id: int, body: IncidentUpdate, conn=Depends(db_dep)):
    """Edit / resolve. Resolving with a note is the day-of flow ('court dried,
    play resumed 14:30'); un-resolving reopens it."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE tournament_incident SET "
            "  site_id = %(site_id)s, occurred_at = COALESCE(%(occurred_at)s, occurred_at), "
            "  category = %(category)s, severity = %(severity)s, "
            "  description = %(description)s, resolved = %(resolved)s, "
            "  resolution = %(resolution)s "
            "WHERE id = %(id)s RETURNING id",
            {**body.model_dump(), "id": incident_id},
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="incident not found")
        cur.execute(_SELECT + " WHERE i.id = %s", (incident_id,))
        return cur.fetchone()


@router.delete("/api/incidents/{incident_id}", status_code=204)
def delete_incident(incident_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM tournament_incident WHERE id = %s", (incident_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="incident not found")
    return Response(status_code=204)
