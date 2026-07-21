"""Admin access-audit API (D19 — who opened player 360 / sensitive views)."""
from fastapi import APIRouter, Depends, Query

from ..db import db_dep
from ..security import require_admin

router = APIRouter(prefix="/api/access-audit", tags=["access-audit"])


@router.get("")
def list_access(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    username: str | None = None,
    action: str | None = None,
    resource_type: str | None = None,
    resource_id: int | None = None,
    user=Depends(require_admin),
    conn=Depends(db_dep),
):
    """Recent access events (newest first). For TD accountability review."""
    del user  # auth gate only
    wh, pr = [], []
    if username:
        wh.append("a.username = %s")
        pr.append(username)
    if action:
        wh.append("a.action ILIKE %s")
        pr.append(f"%{action}%")
    if resource_type:
        wh.append("a.resource_type = %s")
        pr.append(resource_type)
    if resource_id is not None:
        wh.append("a.resource_id = %s")
        pr.append(resource_id)
    where_sql = (" WHERE " + " AND ".join(wh)) if wh else ""
    with conn.cursor() as cur:
        cur.execute(f"SELECT count(*) AS n FROM access_audit a{where_sql}", pr)
        total = cur.fetchone()["n"]
        cur.execute(
            f"""
            SELECT a.id, a.accessed_at, a.username, a.action, a.resource_type,
                   a.resource_id, a.tournament_id, a.client_kind, a.detail,
                   t.name AS tournament_name
            FROM access_audit a
            LEFT JOIN tournament t ON t.id = a.tournament_id
            {where_sql}
            ORDER BY a.accessed_at DESC, a.id DESC
            LIMIT %s OFFSET %s
            """,
            pr + [limit, offset],
        )
        rows = [{
            "id": r["id"],
            "accessed_at": r["accessed_at"].isoformat(),
            "username": r["username"],
            "action": r["action"],
            "resource_type": r["resource_type"],
            "resource_id": r["resource_id"],
            "tournament_id": r["tournament_id"],
            "tournament_name": r["tournament_name"],
            "client_kind": r["client_kind"],
            "detail": r["detail"],
        } for r in cur.fetchall()]
    return {"items": rows, "total": total, "limit": limit, "offset": offset}
