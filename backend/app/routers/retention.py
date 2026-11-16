"""Retention job endpoints (PII hardening H3 — docs/pii-hardening-plan.md).

`GET /api/retention/policy`  → the configured schedule (the written policy).
`POST /api/retention/sweep`  → run the policy sweep; `dry_run=true` (default)
                               only counts, `dry_run=false` redacts. A write must
                               name a tournament or all_tournaments=true, and
                               outside a demo deployment needs the caller's
                               password. Wire to a scheduler in production.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..access_audit import log_access
from ..db import db_dep
from ..retention import policy, run_retention
from ..security import (
    assert_reauth_allowed,
    clear_reauth_failures,
    demo_credentials_allowed,
    require_admin,
    verify_caller_password,
)

router = APIRouter(prefix="/api/retention", tags=["retention"])


@router.get("/policy")
def get_policy():
    return policy()


@router.post("/sweep")
def sweep(dry_run: bool = True, older_than_days: int | None = None,
          tournament_id: int | None = None, all_tournaments: bool = False,
          current_password: str | None = None,
          user=Depends(require_admin), conn=Depends(db_dep)):
    # Mirror /api/emails/purge: a negative window would redact EVERY filed email
    # (the cutoff becomes a future date). Refuse it before touching any rows.
    if older_than_days is not None and older_than_days < 0:
        raise HTTPException(status_code=400, detail="older_than_days must be >= 0")
    # AUTHZ-23: an unattended, DB-wide redaction with no preview is one call away
    # from erasing the wrong window. Scope a write, and prove the caller outside
    # a demo deployment.
    if not dry_run:
        if tournament_id is None and not all_tournaments:
            raise HTTPException(
                status_code=400,
                detail="choose a tournament or all_tournaments=true",
            )
        if tournament_id is not None and all_tournaments:
            raise HTTPException(
                status_code=400,
                detail="tournament_id and all_tournaments are mutually exclusive",
            )
    demo = demo_credentials_allowed()
    if not dry_run and not demo:
        assert_reauth_allowed(user["id"])
    with conn.cursor() as cur:
        if not dry_run and not demo:
            verify_caller_password(cur, user, current_password,
                                   action="run the retention sweep")
        out = run_retention(cur, older_than_days=older_than_days, dry_run=dry_run,
                            tournament_id=tournament_id)
        if not dry_run:
            # A sweep deletes import batches and redacts bodies; a scheduled job
            # that leaves no attributable row cannot be reviewed after the fact.
            log_access(
                cur, username=user["username"], action="retention_sweep",
                resource_type="email_message",
                tournament_id=tournament_id,
                detail={"older_than_days": out["older_than_days"],
                        "total_eligible": out["total_eligible"],
                        "all_tournaments": all_tournaments},
            )
    if not dry_run and not demo:
        clear_reauth_failures(user["id"])
    return out
