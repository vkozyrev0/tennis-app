"""Admin (TD) account management — multi-user TD access (D8).

Moves past the single shared `admin` login: an admin can create / list / remove
other admin accounts and reset their passwords. Scoped to **admin-role** accounts
only — officials' logins are managed from the Official detail. The router is
mounted admin-only (require_admin) in main.py.
"""
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import AdminUserCreate, AdminUserOut, AdminUserPatch, PasswordReset
from ..security import get_current_user, hash_pw

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
def create_admin(body: AdminUserCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO user_account (username, password_hash, role, can_export_pii) "
                f"VALUES (%s, %s, 'admin', %s) RETURNING {_COLS}",
                (body.username, hash_pw(body.password), body.can_export_pii),
            )
            return cur.fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="username already exists")


@router.patch("/{user_id}", response_model=AdminUserOut)
def patch_admin(user_id: int, body: AdminUserPatch, conn=Depends(db_dep)):
    """H4.2: grant/revoke full minors-PII CSV export for an admin account."""
    if body.can_export_pii is None:
        raise HTTPException(status_code=400, detail="no fields to update")
    with conn.cursor() as cur:
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
        return cur.fetchone()


def _admin_or_404(cur, user_id: int) -> None:
    cur.execute("SELECT 1 FROM user_account WHERE id = %s AND role = 'admin'", (user_id,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="admin account not found")


@router.post("/{user_id}/password", status_code=204)
def reset_password(user_id: int, body: PasswordReset, conn=Depends(db_dep)):
    """Reset an admin's password and invalidate their sessions (forces re-login)."""
    with conn.cursor() as cur:
        _admin_or_404(cur, user_id)
        cur.execute(
            "UPDATE user_account SET password_hash = %s WHERE id = %s",
            (hash_pw(body.password), user_id),
        )
        cur.execute("DELETE FROM session WHERE user_id = %s", (user_id,))
    return Response(status_code=204)


@router.delete("/{user_id}", status_code=204)
def delete_admin(user_id: int, me=Depends(get_current_user), conn=Depends(db_dep)):
    with conn.cursor() as cur:
        _admin_or_404(cur, user_id)
        if user_id == me["id"]:
            raise HTTPException(status_code=400, detail="you can't delete your own account")
        cur.execute("SELECT count(*) AS n FROM user_account WHERE role = 'admin'")
        if cur.fetchone()["n"] <= 1:
            raise HTTPException(status_code=409, detail="can't delete the last admin account")
        cur.execute("DELETE FROM user_account WHERE id = %s", (user_id,))  # sessions cascade
    return Response(status_code=204)
