"""POC authentication helpers: pbkdf2 password hashing + cookie-session lookup.

Not production-grade (localhost POC) but real: salted pbkdf2-sha256 hashes, a
server-side session token in an HttpOnly cookie, role-based dependencies.
"""
import hashlib
import hmac
import secrets

from fastapi import Cookie, Depends, HTTPException

from .db import db_dep

COOKIE_NAME = "sid"
_ITERATIONS = 200_000


def hash_pw(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), _ITERATIONS)
    return f"pbkdf2_sha256${_ITERATIONS}${salt}${dk.hex()}"


def verify_pw(password: str, stored: str) -> bool:
    try:
        _algo, iters, salt, h = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), h)
    except Exception as e:
        # Audit P15: a bricked admin account used to manifest as "wrong
        # password" with no signal — log so the hash parse failure is visible.
        import logging
        logging.warning("verify_pw failed to parse stored hash: %r", e)
        return False


def get_current_user(sid: str | None = Cookie(default=None), conn=Depends(db_dep)) -> dict:
    if not sid:
        raise HTTPException(status_code=401, detail="not authenticated")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT u.id, u.username, u.role, u.official_id, u.can_export_pii, "
            "       u.must_change_password "
            "FROM session s JOIN user_account u ON u.id = s.user_id "
            "WHERE s.token = %s AND s.expires_at > now()",
            (sid,),
        )
        user = cur.fetchone()
    if user is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    user["must_change_password"] = bool(user.get("must_change_password"))
    user["can_export_pii"] = bool(user.get("can_export_pii", True))
    return user


def password_change_required(user: dict) -> bool:
    """True when the account must rotate its password before app use.

    Enforcement (403) applies only in prod (or COURTOPS_FORCE_PASSWORD_CHANGE=1)
    so local POC / demo / tests keep working with admin/admin. The flag is still
    returned on login/me so the SPA can nudge even in dev.
    """
    if not user.get("must_change_password"):
        return False
    import os
    from .config import settings
    raw = os.getenv("COURTOPS_FORCE_PASSWORD_CHANGE", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return settings.is_prod()


def require_usable_session(user=Depends(get_current_user)) -> dict:
    """Like get_current_user but 403 when a forced password change is pending."""
    if password_change_required(user):
        raise HTTPException(
            status_code=403,
            detail="password change required — POST /api/auth/change-password",
        )
    return user


def require_admin(user=Depends(require_usable_session)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return user


def require_export_pii(user=Depends(require_admin)) -> dict:
    """H4.2: admin who may download full minors-PII CSVs (can_export_pii)."""
    from .export_gate import require_can_export_pii
    require_can_export_pii(user, redacted=False)
    return user
