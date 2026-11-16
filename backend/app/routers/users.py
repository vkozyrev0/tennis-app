"""Admin (TD) account management — multi-user TD access (D8).

Moves past the single shared `admin` login: an admin can create / list / remove
other admin accounts and reset their passwords. Scoped to **admin-role** accounts
only — officials' logins are managed from the Official detail. The router is
mounted admin-only (require_admin) in main.py.

Security notes (post-pentest):
- A credential reset for *another* admin needs the caller to prove its own
  password, so a stolen session cannot silently take over a peer (AUTH-05).
- Nobody can grant the PII-export capability to themselves (AUTHZ-02).
- The "keep one export-capable admin" invariant is checked under a row lock, and
  the delete path consults it too (AUTHZ-15).
- Password length policy applies on shared deployments (AUTH-06).
"""
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ..access_audit import log_access
from ..db import db_dep
from ..models import AdminUserCreate, AdminUserOut, AdminUserPatch, PasswordReset
from ..security import (
    assert_reauth_allowed,
    check_password_policy,
    clear_reauth_failures,
    get_current_user,
    hash_pw,
    note_reauth_failure,
    verify_pw,
)

router = APIRouter(prefix="/api/admin/users", tags=["admin-users"])

_COLS = "id, username, role, can_export_pii, created_at"


@router.get("", response_model=list[AdminUserOut])
def list_admins(conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLS} FROM user_account WHERE role = 'admin' ORDER BY username"
        )
        return cur.fetchall()


@router.post("", response_model=AdminUserOut, status_code=201)
def create_admin(body: AdminUserCreate, request: Request,
                 me=Depends(get_current_user), conn=Depends(db_dep)):
    check_password_policy(body.password)
    # AUTHZ-02/07 (third pass): only an admin who can export may mint another
    # exporter, or a blinded admin creates a fresh exporting account.
    if body.can_export_pii and not me.get("can_export_pii"):
        raise HTTPException(
            status_code=403,
            detail="only an admin with PII export can create one with PII export",
        )
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO user_account (username, password_hash, role, can_export_pii) "
                f"VALUES (%s, %s, 'admin', %s) RETURNING {_COLS}",
                (body.username, hash_pw(body.password), body.can_export_pii),
            )
            row = cur.fetchone()
            log_access(
                cur, username=me["username"], action="create", resource_type="admin_account",
                resource_id=row["id"], detail={"can_export_pii": bool(body.can_export_pii)},
            )
            return row
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="username already exists")


@router.patch("/{user_id}", response_model=AdminUserOut)
def patch_admin(user_id: int, body: AdminUserPatch, me=Depends(get_current_user),
                conn=Depends(db_dep)):
    """H4.2: grant/revoke full minors-PII CSV export for an admin account."""
    if body.can_export_pii is None:
        raise HTTPException(status_code=400, detail="no fields to update")
    # AUTHZ-02: the capability is meant to be granted by a *peer*. Letting the
    # holder re-grant it makes a revocation meaningless.
    if body.can_export_pii is True and not me.get("can_export_pii"):
        raise HTTPException(
            status_code=403,
            detail="only an admin with PII export can grant it to another",
        )
    if body.can_export_pii is True and user_id == me["id"]:
        raise HTTPException(
            status_code=403,
            detail="you cannot grant PII export to yourself — ask another admin",
        )
    with conn.cursor() as cur:
        _lock_admin_rows(cur)
        _admin_or_404(cur, user_id)
        # Keep at least one admin who can export PII so the TD is never locked out.
        if body.can_export_pii is False:
            cur.execute(
                "SELECT can_export_pii FROM user_account WHERE id = %s", (user_id,)
            )
            row = cur.fetchone()
            if row and row["can_export_pii"]:
                cur.execute(
                    "SELECT count(*) AS n FROM user_account "
                    "WHERE role = 'admin' AND can_export_pii AND id <> %s",
                    (user_id,),
                )
                if cur.fetchone()["n"] < 1:
                    raise HTTPException(
                        status_code=409,
                        detail="can't revoke export on the last admin with can_export_pii",
                    )
        cur.execute(
            f"UPDATE user_account SET can_export_pii = %s WHERE id = %s "
            f"RETURNING {_COLS}",
            (body.can_export_pii, user_id),
        )
        out = cur.fetchone()
        log_access(
            cur, username=me["username"], action="export_capability", resource_type="admin_account",
            resource_id=user_id, detail={"can_export_pii": bool(body.can_export_pii)},
        )
        return out


def _lock_admin_rows(cur) -> None:
    """Serialize admin-capability changes so the last-exporter check is atomic.

    Without this, two concurrent revocations each see the other exporter present
    and both pass, leaving zero exporters (AUTHZ-15).
    """
    cur.execute("SELECT id FROM user_account WHERE role = 'admin' ORDER BY id FOR UPDATE")


def _admin_or_404(cur, user_id: int) -> None:
    cur.execute("SELECT 1 FROM user_account WHERE id = %s AND role = 'admin'", (user_id,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="admin account not found")


def _verify_caller_password(cur, me: dict, supplied: str | None) -> None:
    if not supplied:
        raise HTTPException(
            status_code=400,
            detail="current_password is required to change another admin's password",
        )
    cur.execute("SELECT password_hash FROM user_account WHERE id = %s", (me["id"],))
    row = cur.fetchone()
    if row is None or not verify_pw(supplied, row["password_hash"]):
        note_reauth_failure(me["id"])
        raise HTTPException(status_code=403, detail="current password is incorrect")


@router.post("/{user_id}/password", status_code=204)
def reset_password(user_id: int, body: PasswordReset,
                   me=Depends(get_current_user), conn=Depends(db_dep)):
    """Reset an admin's password and invalidate their sessions (forces re-login).

    AUTH-04: the caller's own password is required for **every** reset, including
    a self-reset — otherwise a stolen cookie is a one-request account takeover.
    AUTH-06: failures are throttled, so the reset path is not a password oracle.
    """
    assert_reauth_allowed(me["id"])
    with conn.cursor() as cur:
        _admin_or_404(cur, user_id)
        _verify_caller_password(cur, me, body.current_password)
        check_password_policy(body.password)
        cur.execute(
            "UPDATE user_account SET password_hash = %s WHERE id = %s",
            (hash_pw(body.password), user_id),
        )
        cur.execute("DELETE FROM session WHERE user_id = %s", (user_id,))
        log_access(
            cur, username=me["username"], action="reset_password", resource_type="admin_account",
            resource_id=user_id, detail={"self": user_id == me["id"]},
        )
    clear_reauth_failures(me["id"])
    return Response(status_code=204)


@router.delete("/{user_id}", status_code=204)
def delete_admin(user_id: int, me=Depends(get_current_user), conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _lock_admin_rows(cur)
        _admin_or_404(cur, user_id)
        if user_id == me["id"]:
            raise HTTPException(status_code=400, detail="you can't delete your own account")
        cur.execute("SELECT count(*) AS n FROM user_account WHERE role = 'admin'")
        if cur.fetchone()["n"] <= 1:
            raise HTTPException(status_code=409, detail="can't delete the last admin account")
        # Deleting the last export-capable admin breaks the same invariant PATCH
        # protects; the count here used to ignore can_export_pii entirely.
        cur.execute(
            "SELECT can_export_pii FROM user_account WHERE id = %s", (user_id,)
        )
        target = cur.fetchone()
        if target and target["can_export_pii"]:
            cur.execute(
                "SELECT count(*) AS n FROM user_account "
                "WHERE role = 'admin' AND can_export_pii AND id <> %s",
                (user_id,),
            )
            if cur.fetchone()["n"] < 1:
                raise HTTPException(
                    status_code=409,
                    detail="can't delete the last admin with can_export_pii",
                )
        cur.execute("DELETE FROM user_account WHERE id = %s", (user_id,))  # sessions cascade
        log_access(
            cur, username=me["username"], action="delete", resource_type="admin_account",
            resource_id=user_id,
        )
    return Response(status_code=204)
