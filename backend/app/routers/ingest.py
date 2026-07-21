"""Token-authenticated inbound email webhook (D4 — dedicated forwarding address).

Open endpoints (no admin session): providers cannot hold a browser cookie.
Auth is a shared secret (``INGEST_TOKEN``) presented as:

- ``Authorization: Bearer <token>``
- ``X-Ingest-Token: <token>``
- ``?token=<token>`` (last resort for providers that only allow a URL secret)

When ``INGEST_TOKEN`` is unset the endpoints return **503** (ingest disabled).

Endpoints:

- ``POST /api/ingest/email`` — JSON body (canonical)
- ``POST /api/ingest/email/form`` — multipart/form-data (Mailgun / SendGrid-style)
- ``GET  /api/ingest/status`` — whether ingest is configured (no secret leaked)

Bodies are encrypted at rest; nothing logs the body. Human review still files
each message into structured lists.
"""
from __future__ import annotations

import logging
import os
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel

from ..db import db_dep
from ..email_ingest import (
    ingest_email,
    payload_from_mapping,
)

router = APIRouter(prefix="/api/ingest", tags=["ingest"])
log = logging.getLogger("courtops.ingest")


def _configured_token() -> str:
    return os.getenv("INGEST_TOKEN", "").strip()


def _query_token_allowed() -> bool:
    """Query-string secrets leak via access logs / Referer. Allowed in dev for
    providers that only accept a URL secret; refused in prod unless explicitly
    re-enabled (INGEST_ALLOW_QUERY_TOKEN=1). Audit D4."""
    override = os.getenv("INGEST_ALLOW_QUERY_TOKEN", "").strip().lower()
    if override in {"1", "true", "yes"}:
        return True
    if override in {"0", "false", "no"}:
        return False
    from ..config import settings
    return not settings.is_prod()


def _require_ingest_token(
    request: Request,
    token: str | None = Query(default=None, description="Shared secret (prefer headers)"),
) -> None:
    expected = _configured_token()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="email ingest disabled — set INGEST_TOKEN to enable",
        )
    presented = None
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        presented = auth[7:].strip()
    if not presented:
        presented = (request.headers.get("x-ingest-token") or "").strip() or None
    if not presented and token:
        if not _query_token_allowed():
            raise HTTPException(
                status_code=401,
                detail="query-string token disabled — use Authorization: Bearer "
                "or X-Ingest-Token (set INGEST_ALLOW_QUERY_TOKEN=1 only if required)",
            )
        presented = token.strip()
    if not presented or not secrets.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="invalid or missing ingest token")


class IngestEmailIn(BaseModel):
    """Canonical JSON shape for auto-ingest. Provider aliases are also accepted
    via the form endpoint; this model documents the preferred fields."""
    message_id: str | None = None
    from_address: str | None = None
    to_address: str | None = None
    subject: str | None = None
    body: str | None = None
    tournament_id: int | None = None
    received_at: str | int | float | None = None
    # When false, leave classification as unclassified (still status=new).
    auto_classify: bool = True


class IngestResult(BaseModel):
    id: int
    duplicate: bool = False
    tournament_id: int | None = None
    classification: str | None = None
    status: str | None = None
    message_id: str | None = None


@router.get("/status")
def ingest_status():
    """Whether auto-ingest is armed. Does not reveal the token."""
    return {
        "enabled": bool(_configured_token()),
        "default_tournament_id": (
            int(v) if (v := os.getenv("INGEST_DEFAULT_TOURNAMENT_ID", "").strip()).isdigit()
            else None
        ),
        "endpoints": {
            "json": "POST /api/ingest/email",
            "form": "POST /api/ingest/email/form",
        },
        "auth": [
            "Authorization: Bearer <INGEST_TOKEN>",
            "X-Ingest-Token: <INGEST_TOKEN>",
            "?token=<INGEST_TOKEN>",
        ],
    }


@router.post("/email", response_model=IngestResult)
def ingest_email_json(
    body: IngestEmailIn,
    request: Request,
    response: Response,
    conn=Depends(db_dep),
    _auth=Depends(_require_ingest_token),
):
    """Ingest one email from a JSON body (preferred)."""
    data = body.model_dump(exclude={"auto_classify"})
    payload = payload_from_mapping(data, source="webhook")
    return _run_ingest(conn, payload, response=response, auto_classify=body.auto_classify)


@router.post("/email/form", response_model=IngestResult)
async def ingest_email_form(
    request: Request,
    response: Response,
    conn=Depends(db_dep),
    _auth=Depends(_require_ingest_token),
):
    """Ingest one email from multipart/form-data or x-www-form-urlencoded.

    Field aliases cover Mailgun (``sender``, ``recipient``, ``body-plain``,
    ``stripped-text``, ``Message-Id``) and SendGrid Inbound Parse (``from``,
    ``to``, ``text``, ``html``, ``headers``).
    """
    ctype = (request.headers.get("content-type") or "").lower()
    form_map: dict[str, Any] = {}
    if "application/json" in ctype:
        form_map = await request.json()
        if not isinstance(form_map, dict):
            raise HTTPException(status_code=400, detail="JSON body must be an object")
    else:
        form = await request.form()
        for k, v in form.multi_items():
            # Skip file uploads; body should be text fields.
            if hasattr(v, "read"):
                continue
            # First wins for multi-valued keys unless empty.
            if k not in form_map or form_map[k] in (None, ""):
                form_map[k] = v

    auto_classify = str(form_map.get("auto_classify", "true")).lower() not in {
        "0", "false", "no",
    }
    payload = payload_from_mapping(form_map, source="form")
    return _run_ingest(conn, payload, response=response, auto_classify=auto_classify)


def _run_ingest(conn, payload, *, response: Response, auto_classify: bool) -> IngestResult:
    try:
        with conn.cursor() as cur:
            result = ingest_email(cur, payload, auto_classify=auto_classify)
    except LookupError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    # Never log body/subject (minors' PII). message_id + id only.
    log.info(
        "ingest %s id=%s tournament_id=%s classification=%s",
        "duplicate" if result.get("duplicate") else "created",
        result.get("id"),
        result.get("tournament_id"),
        result.get("classification"),
    )
    # 201 created / 200 duplicate — both 2xx so webhook providers stop retrying.
    response.status_code = 200 if result.get("duplicate") else 201
    return IngestResult(**{k: result.get(k) for k in (
        "id", "duplicate", "tournament_id", "classification", "status", "message_id",
    )})
