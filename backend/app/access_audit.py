"""Append-only PII *view* audit (D19).

Records *who* opened *which* sensitive surface and *when* — never names,
emails, phones, or birthdates. Complements export_audit (H4.1), which covers
CSV downloads rather than interactive views.
"""
from __future__ import annotations

import json
from typing import Any


def log_access(
    cur,
    *,
    username: str,
    action: str,
    resource_type: str,
    resource_id: int | None = None,
    tournament_id: int | None = None,
    client_kind: str = "api",
    detail: dict[str, Any] | None = None,
) -> int:
    """Insert one access_audit row. Returns the new id."""
    username = (username or "").strip()[:80] or "?"
    action = (action or "").strip()[:80] or "view"
    resource_type = (resource_type or "").strip()[:40] or "unknown"
    if client_kind not in ("browser", "api"):
        client_kind = "api"
    cur.execute(
        """
        INSERT INTO access_audit
            (username, action, resource_type, resource_id, tournament_id, client_kind, detail)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
        RETURNING id
        """,
        (
            username,
            action,
            resource_type,
            resource_id,
            tournament_id,
            client_kind,
            json.dumps(detail) if detail is not None else None,
        ),
    )
    return cur.fetchone()["id"]
