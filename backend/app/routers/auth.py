"""Login / logout / me — cookie-session auth (POC)."""
import os
import secrets
import time
from collections import defaultdict
from threading import Lock

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response

from ..db import db_dep
from ..models import LoginIn, PasswordChange
from ..security import COOKIE_NAME, get_current_user, hash_pw, verify_pw

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Constant valid-format hash so a login for a NONEXISTENT username still pays the
# full PBKDF2 cost. Without it, a missing user short-circuits past verify_pw and
# the 401 comes back measurably faster than for a real user (whose password is
# hashed) — a user-enumeration timing side-channel. Computed once at import.
_DUMMY_HASH = hash_pw(secrets.token_urlsafe(16))


# In-process rate limiter: keyed on (client_ip, username_lower). 5 failures in
# 5 minutes trip a 5-minute lockout. Resets on a successful login. For a POC
# this is intentionally in-memory; a multi-worker deployment needs a shared
# store (Redis or a `login_attempt` table).
_FAIL_WINDOW_S = 300
_FAIL_LIMIT = 5
_LOCKOUT_S = 300
_attempts: dict[tuple[str, str], list[float]] = defaultdict(list)
_locked_until: dict[tuple[str, str], float] = {}
_lock = Lock()


_MAX_TRACKED_KEYS = 10_000  # bound the dict so a sprayer can't exhaust memory


import random  # imported lazily; module scope keeps it cheap


def _gc_attempts(now: float) -> None:
    """Audit F24: GC walks a *snapshot* of the keys; only individual updates
    touch the dict under the lock. Avoids holding `_lock` across an O(n) walk
    while a login storm is in flight."""
    snapshot_keys = list(_attempts.keys())
    for k in snapshot_keys:
        with _lock:
            bucket = _attempts.get(k)
            if bucket is None:
                continue
            kept = [t for t in bucket if now - t < _FAIL_WINDOW_S]
            if kept:
                _attempts[k] = kept
            else:
                _attempts.pop(k, None)
    with _lock:
        for k, until in list(_locked_until.items()):
            if now >= until:
                _locked_until.pop(k, None)


def _record_fail(key: tuple[str, str]) -> None:
    now = time.monotonic()
    # Audit N6 + M11 + F24: opportunistic GC of stale entries. Trigger at hard
    # cap or on ~1% of calls so cleanup pressure tracks the request rate.
    if len(_attempts) > _MAX_TRACKED_KEYS or random.random() < 0.01:
        _gc_attempts(now)
    with _lock:
        bucket = [t for t in _attempts[key] if now - t < _FAIL_WINDOW_S]
        bucket.append(now)
        _attempts[key] = bucket
        if len(bucket) >= _FAIL_LIMIT:
            _locked_until[key] = now + _LOCKOUT_S


def _check_lock(key: tuple[str, str]) -> None:
    now = time.monotonic()
    with _lock:
        until = _locked_until.get(key)
        if until and now < until:
            raise HTTPException(
                status_code=429,
                detail=f"too many failed attempts; retry in {int(until - now)}s",
            )
        if until and now >= until:
            _locked_until.pop(key, None)
            _attempts.pop(key, None)


def _clear_attempts(key: tuple[str, str]) -> None:
    with _lock:
        _attempts.pop(key, None)
        _locked_until.pop(key, None)


def _secure_cookie() -> bool:
    """HTTPS-only cookies. Explicit COURTOPS_SECURE_COOKIE wins; otherwise on
    when ENV is a shared/hosted value (audit B1 / D3) so a prod deploy cannot
    silently ship session cookies over plain HTTP. Dev stays off so localhost works."""
    raw = os.getenv("COURTOPS_SECURE_COOKIE", "").strip().lower()
    if raw in {"1", "true", "yes"}:
        return True
    if raw in {"0", "false", "no"}:
        return False
    from ..config import settings
    return settings.is_prod()


def _session_days() -> int:
    """Session lifetime in days. COURTOPS_SESSION_DAYS (1–90).

    Default **30** in dev/test (POC convenience); default **7** when ENV is
    prod (audit D3) unless the env var is set explicitly.
    """
    raw = os.getenv("COURTOPS_SESSION_DAYS")
    if raw is None or str(raw).strip() == "":
        from ..config import settings
        return 7 if settings.is_prod() else 30
    try:
        days = int(raw)
    except ValueError:
        days = 30
    return max(1, min(days, 90))


def _session_ttl_sql() -> str:
    return f"{_session_days()} days"


def _user_public(user: dict) -> dict:
    return {
        "username": user["username"],
        "role": user["role"],
        "official_id": user["official_id"],
        "can_export_pii": bool(user.get("can_export_pii", True)),
        "must_change_password": bool(user.get("must_change_password")),
        "session_days": _session_days(),
    }


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, conn=Depends(db_dep)):
    client_ip = request.client.host if request.client else "?"
    key = (client_ip, (body.username or "").strip().lower())
    _check_lock(key)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, username, password_hash, role, official_id, can_export_pii, "
            "       must_change_password "
            "FROM user_account WHERE username = %s",
            (body.username,),
        )
        user = cur.fetchone()
        if user is None or not verify_pw(body.password, user["password_hash"]):
            # Equalize timing: a missing user must still run PBKDF2 once, or the
            # faster 401 leaks which usernames exist (see _DUMMY_HASH).
            if user is None:
                verify_pw(body.password, _DUMMY_HASH)
            _record_fail(key)
            raise HTTPException(status_code=401, detail="invalid username or password")
        # D3: still on the POC default admin/admin password → require rotation
        # (enforced in prod via require_usable_session; SPA always sees the flag).
        if user["username"] == "admin" and verify_pw("admin", user["password_hash"]):
            cur.execute(
                "UPDATE user_account SET must_change_password = true WHERE id = %s",
                (user["id"],),
            )
            user["must_change_password"] = True
        # Successful auth — rotate any pre-existing token for this user (defends
        # against session fixation) and start fresh.
        cur.execute("DELETE FROM session WHERE expires_at <= now()")  # opportunistic cleanup
        cur.execute("DELETE FROM session WHERE user_id = %s", (user["id"],))
        token = secrets.token_urlsafe(32)
        cur.execute(
            "INSERT INTO session (token, user_id, expires_at) "
            "VALUES (%s, %s, now() + %s::interval)",
            (token, user["id"], _session_ttl_sql()),
        )
    _clear_attempts(key)
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, samesite="strict", path="/",
        secure=_secure_cookie(),
    )
    return _user_public(user)


@router.post("/logout")
def logout(response: Response, sid: str | None = Cookie(default=None), conn=Depends(db_dep)):
    if sid:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM session WHERE token = %s", (sid,))
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.post("/change-password")
def change_password(body: PasswordChange, sid: str | None = Cookie(default=None),
                    user=Depends(get_current_user), conn=Depends(db_dep)):
    """Self-service password change for ANY logged-in user (admin or official).
    Verifies the current password, sets the new one, and invalidates every OTHER
    session for this user (other devices must re-login); the caller's current
    session is kept alive so they aren't logged out of the tab they're using."""
    with conn.cursor() as cur:
        cur.execute("SELECT password_hash FROM user_account WHERE id = %s", (user["id"],))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="account not found")
        if not verify_pw(body.current_password, row["password_hash"]):
            raise HTTPException(status_code=400, detail="current password is incorrect")
        if verify_pw(body.new_password, row["password_hash"]):
            raise HTTPException(status_code=400, detail="new password must differ from the current one")
        cur.execute(
            "UPDATE user_account SET password_hash = %s, "
            "  must_change_password = false WHERE id = %s",
            (hash_pw(body.new_password), user["id"]),
        )
        # Invalidate other sessions (defends a leaked/old cookie); keep this one.
        cur.execute(
            "DELETE FROM session WHERE user_id = %s AND token <> %s",
            (user["id"], sid),
        )
    return {"ok": True, "must_change_password": False}


@router.get("/me")
def me(user=Depends(get_current_user)):
    return _user_public(user)
