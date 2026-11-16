"""POC authentication helpers: pbkdf2 password hashing + cookie-session lookup.

Not production-grade (localhost POC) but real: salted pbkdf2-sha256 hashes, a
server-side session token in an HttpOnly cookie, role-based dependencies.
"""
import hashlib
import hmac
import os
import secrets
import time
from threading import Lock

from fastapi import Cookie, Depends, HTTPException, Request, Response

from .db import db_dep

COOKIE_NAME = "sid"
_ITERATIONS = 200_000

# The passwords the POC seeds advertise. They are demo fixtures, not secrets.
DEMO_CREDENTIALS = {"admin": "admin", "official": "official"}


def demo_credentials_allowed() -> bool:
    """Whether the seeded demo passwords may authenticate.

    **Server-side configuration, never the request.** An earlier revision judged
    this from the request host, which meant `Host: localhost` from anywhere
    opened the gate (review 2026-11-15, critical). Default is deny; a local demo
    opts in explicitly with ``COURTOPS_ALLOW_DEMO_CREDENTIALS=1`` in its compose
    file or shell. Tests set it in conftest.
    """
    raw = os.getenv("COURTOPS_ALLOW_DEMO_CREDENTIALS", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def is_demo_credential(
    username: str | None, password: str | None, role: str | None = None
) -> bool:
    """True for one of the seeded POC fixtures (admin/admin, official/<user>)."""
    if role == "official" and hmac.compare_digest("official", password or ""):
        return True
    expected = DEMO_CREDENTIALS.get((username or "").strip().lower())
    return expected is not None and hmac.compare_digest(expected, password or "")


MIN_PASSWORD_LEN = 8


def check_password_policy(password: str | None) -> None:
    """AUTH-06: a floor on account passwords.

    Skipped only on a deployment that has *explicitly* opted into demo
    credentials (``COURTOPS_ALLOW_DEMO_CREDENTIALS=1``) — the seeded fixtures and
    the test suite live there. The decision is server configuration; it never
    reads the request (review 2026-11-15 showed a Host header could skip it).
    """
    if demo_credentials_allowed():
        return
    if len(password or "") < MIN_PASSWORD_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"password must be at least {MIN_PASSWORD_LEN} characters",
        )


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


def _current_request(request: Request) -> Request:
    """Dependency shim so `request` can be an optional parameter (FastAPI rejects
    ``Request | None`` as a field type, and tests call these helpers directly)."""
    return request


def get_current_user(
    response: Response,
    sid: str | None = Cookie(default=None),
    conn=Depends(db_dep),
    request: Request = Depends(_current_request),
) -> dict:
    if not sid:
        raise HTTPException(status_code=401, detail="not authenticated")
    from .routers.auth import _attach_cookie, _session_ttl_sql
    # AUTH-08: an absolute lifetime cap, so relentless activity cannot keep a
    # stolen cookie alive forever. The sliding window renews up to this bound.
    max_days = _absolute_session_days()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT u.id, u.username, u.role, u.official_id, u.can_export_pii, "
            "       u.must_change_password "
            "FROM session s JOIN user_account u ON u.id = s.user_id "
            "WHERE s.token = %s AND s.expires_at > now() "
            "  AND s.created_at > now() - %s::interval",
            (sid, f"{max_days} days"),
        )
        user = cur.fetchone()
        if user is None:
            raise HTTPException(status_code=401, detail="not authenticated")
        # Sliding expiry: any authenticated API call renews the session.
        # Throttle writes to ~hourly so a menu click (many parallel GETs)
        # does not UPDATE once per request.
        ttl = _session_ttl_sql()
        cur.execute(
            """
            UPDATE session SET expires_at = now() + %s::interval
            WHERE token = %s
              AND expires_at < now() + %s::interval - interval '1 hour'
            """,
            (ttl, sid, ttl),
        )
        if cur.rowcount:
            _attach_cookie(response, sid)
    user["must_change_password"] = bool(user.get("must_change_password"))
    user["can_export_pii"] = bool(user.get("can_export_pii", True))
    return user


def _absolute_session_days() -> int:
    """Hard ceiling on a session's total age (AUTH-08). Default 7 days."""
    raw = os.getenv("COURTOPS_SESSION_MAX_DAYS", "").strip()
    try:
        days = int(raw) if raw else 7
    except ValueError:
        days = 7
    return max(1, min(days, 90))


def password_change_required(user: dict, request: Request | None = None) -> bool:
    """True when the account must rotate its password before app use.

    Enforcement (403) applies unless the deployment has *explicitly* opted into
    demo credentials (``COURTOPS_ALLOW_DEMO_CREDENTIALS=1``) — a server-side
    setting, never the request host. ``COURTOPS_FORCE_PASSWORD_CHANGE`` still
    overrides both ways.
    """
    if not user.get("must_change_password"):
        return False
    raw = os.getenv("COURTOPS_FORCE_PASSWORD_CHANGE", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return not demo_credentials_allowed()


def require_usable_session(
    user=Depends(get_current_user), request: Request = Depends(_current_request)
) -> dict:
    """Like get_current_user but 403 when a forced password change is pending."""
    if password_change_required(user, request):
        raise HTTPException(
            status_code=403,
            detail="password change required — POST /api/auth/change-password",
        )
    return user


def require_admin(user=Depends(require_usable_session)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return user


# --- re-authentication throttle -------------------------------------------
# Any endpoint that verifies the caller's own password (change-password, peer
# password reset) is an online password oracle. A hijacked cookie must not be
# able to brute-force the account's password into a full takeover.
_PW_FAIL_WINDOW_S = 300
_PW_FAIL_LIMIT = 5
_pw_fails: dict[int, list[float]] = {}
_pw_lock = Lock()


def assert_reauth_allowed(user_id: int) -> None:
    now = time.monotonic()
    with _pw_lock:
        bucket = [t for t in _pw_fails.get(user_id, []) if now - t < _PW_FAIL_WINDOW_S]
        _pw_fails[user_id] = bucket
        if len(bucket) >= _PW_FAIL_LIMIT:
            wait = int(_PW_FAIL_WINDOW_S - (now - bucket[0]))
            raise HTTPException(
                status_code=429,
                detail=f"too many incorrect password attempts; retry in {max(wait, 1)}s",
            )


def note_reauth_failure(user_id: int) -> None:
    now = time.monotonic()
    with _pw_lock:
        bucket = [t for t in _pw_fails.get(user_id, []) if now - t < _PW_FAIL_WINDOW_S]
        bucket.append(now)
        _pw_fails[user_id] = bucket


def clear_reauth_failures(user_id: int) -> None:
    with _pw_lock:
        _pw_fails.pop(user_id, None)


def verify_caller_password(cur, user: dict, supplied: str | None, *, action: str) -> None:
    """Prove the caller's own password before a re-auth-gated write.

    400 when the field is absent, 403 on a mismatch (recorded so the next call
    is throttled). Lives here rather than in a router: three routers now gate a
    destructive write on it.
    """
    if not supplied:
        raise HTTPException(
            status_code=400,
            detail=f"current_password is required to {action}",
        )
    cur.execute("SELECT password_hash FROM user_account WHERE id = %s", (user["id"],))
    row = cur.fetchone()
    if row is None or not verify_pw(supplied, row["password_hash"]):
        note_reauth_failure(user["id"])
        raise HTTPException(status_code=403, detail="current password is incorrect")
