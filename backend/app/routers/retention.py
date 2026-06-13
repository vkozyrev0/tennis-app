"""Retention job endpoints (PII hardening H3 — docs/pii-hardening-plan.md).

`GET /api/retention/policy`  → the configured schedule (the written policy).
`POST /api/retention/sweep`  → run the policy sweep; `dry_run=true` (default)
                               only counts, `dry_run=false` redacts. Wire to a
                               scheduler in production.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from ..retention import policy, run_retention

router = APIRouter(prefix="/api/retention", tags=["retention"])


@router.get("/policy")
def get_policy():
    return policy()


@router.post("/sweep")
def sweep(dry_run: bool = True, older_than_days: int | None = None, conn=Depends(db_dep)):
    # Mirror /api/emails/purge: a negative window would redact EVERY filed email
    # (the cutoff becomes a future date). Refuse it before touching any rows.
    if older_than_days is not None and older_than_days < 0:
        raise HTTPException(status_code=400, detail="older_than_days must be >= 0")
    with conn.cursor() as cur:
        return run_retention(cur, older_than_days=older_than_days, dry_run=dry_run)
