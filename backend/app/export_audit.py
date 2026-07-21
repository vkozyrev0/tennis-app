"""Append-only export / PII-access audit (H4.1).

Records *who* exported *which resource* and *when* — never the exported rows.
Used by server CSV endpoints and by POST /api/export-audit from the SPA.
"""
from __future__ import annotations

import json
from typing import Any


def log_export(
    cur,
    *,
    username: str,
    resource: str,
    tournament_id: int | None = None,
    client_kind: str = "api",
    detail: dict[str, Any] | None = None,
) -> int:
    """Insert one export_audit row. Returns the new id."""
    resource = (resource or "").strip()[:120] or "unknown"
    username = (username or "").strip()[:80] or "?"
    if client_kind not in ("browser", "api"):
        client_kind = "api"
    cur.execute(
        """
        INSERT INTO export_audit (username, resource, tournament_id, client_kind, detail)
        VALUES (%s, %s, %s, %s, %s::jsonb)
        RETURNING id
        """,
        (
            username,
            resource,
            tournament_id,
            client_kind,
            json.dumps(detail) if detail is not None else None,
        ),
    )
    return cur.fetchone()["id"]
