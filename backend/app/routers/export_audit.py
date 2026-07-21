"""Admin export-audit API (H4.1 / COPPA accountability) + H4.2 export gate."""
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..db import db_dep
from ..export_audit import log_export
from ..export_gate import is_minors_pii_resource, require_can_export_pii
from ..security import require_admin

router = APIRouter(prefix="/api/export-audit", tags=["export-audit"])


class ExportAuditIn(BaseModel):
    """Client-side CSV download (SPA). Server-side exports log themselves."""
    resource: str = Field(..., min_length=1, max_length=120)
    tournament_id: Optional[int] = None
    detail: Optional[dict[str, Any]] = None


@router.post("", status_code=201)
def record_export(body: ExportAuditIn, user=Depends(require_admin), conn=Depends(db_dep)):
    """Log a browser CSV download.

    H4.2: minors-PII resources require ``can_export_pii``. Full (non-redacted)
    dumps also require ``detail.confirmed=true`` (SPA confirm dialog). Redacted
    exports still need the capability flag but skip the confirm footgun.
    """
    detail = body.detail or {}
    redacted = bool(detail.get("redacted"))
    if is_minors_pii_resource(body.resource):
        require_can_export_pii(user, redacted=False)
        if not redacted and not detail.get("confirmed"):
            raise HTTPException(
                status_code=400,
                detail="full minors-PII export requires detail.confirmed=true "
                       "(SPA confirm dialog). Pass detail.redacted=true for a "
                       "column-stripped export without that confirm.",
            )
    with conn.cursor() as cur:
        eid = log_export(
            cur,
            username=user["username"],
            resource=body.resource,
            tournament_id=body.tournament_id,
            client_kind="browser",
            detail=body.detail,
        )
    return {"id": eid, "ok": True}


@router.get("")
def list_exports(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    username: str | None = None,
    resource: str | None = None,
    user=Depends(require_admin),
    conn=Depends(db_dep),
):
    """Recent export events (newest first). For TD accountability review."""
    del user  # auth gate only
    wh, pr = [], []
    if username:
        wh.append("e.username = %s")
        pr.append(username)
    if resource:
        wh.append("e.resource ILIKE %s")
        pr.append(f"%{resource}%")
    where_sql = (" WHERE " + " AND ".join(wh)) if wh else ""
    with conn.cursor() as cur:
        cur.execute(f"SELECT count(*) AS n FROM export_audit e{where_sql}", pr)
        total = cur.fetchone()["n"]
        cur.execute(
            f"""
            SELECT e.id, e.exported_at, e.username, e.resource, e.tournament_id,
                   e.client_kind, e.detail, t.name AS tournament_name
            FROM export_audit e
            LEFT JOIN tournament t ON t.id = e.tournament_id
            {where_sql}
            ORDER BY e.exported_at DESC, e.id DESC
            LIMIT %s OFFSET %s
            """,
            pr + [limit, offset],
        )
        rows = [{
            "id": r["id"],
            "exported_at": r["exported_at"].isoformat(),
            "username": r["username"],
            "resource": r["resource"],
            "tournament_id": r["tournament_id"],
            "tournament_name": r["tournament_name"],
            "client_kind": r["client_kind"],
            "detail": r["detail"],
        } for r in cur.fetchall()]
    return {"items": rows, "total": total, "limit": limit, "offset": offset}
