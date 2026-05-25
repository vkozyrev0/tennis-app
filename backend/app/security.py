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
    except Exception:
        return False


def get_current_user(sid: str | None = Cookie(default=None), conn=Depends(db_dep)) -> dict:
    if not sid:
        raise HTTPException(status_code=401, detail="not authenticated")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT u.id, u.username, u.role, u.official_id "
            "FROM session s JOIN user_account u ON u.id = s.user_id WHERE s.token = %s",
            (sid,),
        )
        user = cur.fetchone()
    if user is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return user


def require_admin(user=Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return user
