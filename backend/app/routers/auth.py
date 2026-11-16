"""Login / logout / me — cookie-session auth (POC)."""
import os
import random
import secrets
import time
from collections import defaultdict
from threading import Lock

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response

from ..access_audit import log_access
from ..db import db_dep
from ..models import LoginIn, PasswordChange
from ..security import (
    COOKIE_NAME,
    _current_request,
    assert_reauth_allowed,
    check_password_policy,
    clear_reauth_failures,
    demo_credentials_allowed,
    get_current_user,
    hash_pw,
    is_demo_credential,
    note_reauth_failure,
    password_change_required,
    verify_pw,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# AUTH-06: a floor for account passwords. Skipped for the seeded demo fixtures
# and on loopback (the POC suite and `admin/admin` are fixtures, not policy);
# enforced on any shared deployment so a reset cannot install "pw".
MIN_PASSWORD_LEN = 8

# Constant valid-format hash so a login for a NONEXISTENT username still pays the
# full PBKDF2 cost. Without it, a missing user short-circuits past verify_pw and
# the 401 comes back measurably faster than for a real user (whose password is
# hashed) — a user-enumeration timing side-channel. Computed once at import.
_DUMMY_HASH = hash_pw(secrets.token_urlsafe(16))


# In-process rate limiter. Two buckets: (client_ip, username_lower) with 5
# failures in 5 minutes, and a global per-IP bucket with 20 failures in the
# same window. The per-key cap alone is bypassed by rotating usernames, and the
# per-IP cap alone would lock out a whole office NAT after one bad actor. Both
# reset after their window; a successful login clears only the user key, never
# the IP bucket. For a POC this is intentionally in-memory; a multi-worker
# deployment needs a shared store (Redis or a `login_attempt` table).
_FAIL_WINDOW_S = 300
_FAIL_LIMIT = 5
_IP_FAIL_LIMIT = 20
_LOCKOUT_S = 300
_attempts: dict[tuple[str, str], list[float]] = defaultdict(list)
_locked_until: dict[tuple[str, str], float] = {}
_ip_attempts: dict[str, list[float]] = defaultdict(list)
_ip_locked_until: dict[str, float] = {}
_lock = Lock()


_MAX_TRACKED_KEYS = 10_000  # bound the dicts so a sprayer can't exhaust memory


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
    for ip in list(_ip_attempts.keys()):
        with _lock:
            bucket = _ip_attempts.get(ip)
            if bucket is None:
                continue
            kept = [t for t in bucket if now - t < _FAIL_WINDOW_S]
            if kept:
                _ip_attempts[ip] = kept
            else:
                _ip_attempts.pop(ip, None)
    with _lock:
        for k, until in list(_locked_until.items()):
            if now >= until:
                _locked_until.pop(k, None)
        for ip, until in list(_ip_locked_until.items()):
            if now >= until:
                _ip_locked_until.pop(ip, None)


def _record_fail(key: tuple[str, str], ip: str | None = None) -> None:
    now = time.monotonic()
    # Audit N6 + M11 + F24: opportunistic GC of stale entries. Trigger at hard
    # cap or on ~1% of calls so cleanup pressure tracks the request rate.
    if len(_attempts) > _MAX_TRACKED_KEYS or random.random() < 0.01:
        _gc_attempts(now)
    with _lock:
        bucket = [t for t in _attempts.get(key, []) if now - t < _FAIL_WINDOW_S]
        bucket.append(now)
        _attempts[key] = bucket
        if len(bucket) >= _FAIL_LIMIT:
            _locked_until[key] = now + _LOCKOUT_S
        if ip is not None:
            ip_bucket = [t for t in _ip_attempts.get(ip, []) if now - t < _FAIL_WINDOW_S]
            ip_bucket.append(now)
            _ip_attempts[ip] = ip_bucket
            if len(ip_bucket) >= _IP_FAIL_LIMIT:
                _ip_locked_until[ip] = now + _LOCKOUT_S


def _check_lock(key: tuple[str, str], ip: str | None = None) -> None:
    """D22: refuse while either the user key or the whole client IP is locked.

    The per-IP bucket catches a sprayer rotating usernames. Deployments behind
    a proxy must set ``FORWARDED_ALLOW_IPS`` (uvicorn trusts only the loopback
    proxy by default) or every client shares the proxy's address and one bad
    actor can lock out the rest.
    """
    now = time.monotonic()
    with _lock:
        until = _locked_until.get(key)
        ip_until = _ip_locked_until.get(ip) if ip is not None else None
        if ip_until is not None and now < ip_until:
            until = max(until or 0.0, ip_until)
        if until is not None and now < until:
            raise HTTPException(
                status_code=429,
                detail=f"too many failed attempts; retry in {int(until - now)}s",
            )
        if until is not None and now >= until:
            _locked_until.pop(key, None)
            _attempts.pop(key, None)
        if ip_until is not None and now >= ip_until:
            _ip_locked_until.pop(ip, None)
            _ip_attempts.pop(ip, None)


def _clear_attempts(key: tuple[str, str]) -> None:
    with _lock:
        _attempts.pop(key, None)
        _locked_until.pop(key, None)


def _secure_cookie() -> bool:
    """Secure by default. The plain-HTTP local demo opts out explicitly with
    COURTOPS_SECURE_COOKIE=0 in compose; everything else ships `Secure`."""
    raw = os.getenv("COURTOPS_SECURE_COOKIE", "").strip().lower()
    return raw not in ("0", "false", "no")


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


def _attach_cookie(response: Response, token: str) -> None:
    """HttpOnly session cookie; max_age tracks COURTOPS_SESSION_DAYS."""
    response.set_cookie(
        COOKIE_NAME, token,
        httponly=True, samesite="strict", path="/",
        secure=_secure_cookie(),
        max_age=_session_days() * 86400,
    )


def _user_public(user: dict, request: Request | None = None) -> dict:
    return {
        "username": user["username"],
        "role": user["role"],
        "official_id": user["official_id"],
        "can_export_pii": bool(user.get("can_export_pii", True)),
        "must_change_password": bool(user.get("must_change_password")),
        "password_change_required": password_change_required(user, request),
        "session_days": _session_days(),
    }


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, conn=Depends(db_dep)):
    client_ip = request.client.host if request.client else "?"
    key = (client_ip, (body.username or "").strip().lower())
    _check_lock(key, client_ip)
    # Count the attempt before verifying, then re-check: a concurrent burst used
    # to pass the check before any of them recorded a failure (AUTH-03).
    _record_fail(key, client_ip)
    _check_lock(key, client_ip)
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
            _audit_login_failure(body.username, client_ip, "invalid_credentials")
            raise HTTPException(status_code=401, detail="invalid username or password")
        # AUTH-01 / AUTH-02: the seeded fixtures are advertised in the docs and
        # were printed on the login page. Unless the *server* opts in
        # (COURTOPS_ALLOW_DEMO_CREDENTIALS=1), they are refused outright — a
        # request header must never decide this (review 2026-11-15, critical).
        # The refusal answers 401 like any wrong password: a distinct status told
        # an attacker which accounts still carry a shipped default.
        if not demo_credentials_allowed() and is_demo_credential(
            user["username"], body.password, user["role"]
        ):
            _audit_login_failure(user["username"], client_ip, "default_credential_refused")
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
    with conn.cursor() as cur:
        log_access(
            cur, username=user["username"], action="login", resource_type="session",
            detail={"role": user["role"]},
        )
    _attach_cookie(response, token)
    return _user_public(user, request)


def _audit_login_failure(username: str | None, client_ip: str, reason: str) -> None:
    """Record a failed login on its own connection.

    The request is about to 500/401 and roll back, so the row would vanish with
    it (AUTH-04, third pass: authentication events were not audited at all).
    """
    try:
        from ..access_audit import log_access
        from ..db import get_conn

        with get_conn() as conn, conn.cursor() as cur:
            log_access(
                cur, username=username or "?", action="login_failed",
                resource_type="session", detail={"ip": client_ip, "reason": reason},
            )
    except Exception:  # noqa: BLE001 - never let auditing break the auth path
        import logging

        logging.warning("login failure audit write failed", exc_info=True)


def _same_origin(request: Request) -> bool:
    """True when the request carries no cross-site Origin/Referer.

    SameSite=strict already keeps the cookie off a cross-site POST, but logout
    needs a session to act, and a cross-site form post would otherwise get a
    Set-Cookie that clears the victim's cookie (forced-logout CSRF, AUTH-11).
    """
    source = request.headers.get("origin") or request.headers.get("referer")
    if not source:
        return True
    from urllib.parse import urlparse

    src = urlparse(source)
    if not src.hostname:
        return True
    return src.hostname.lower() == (request.url.hostname or "").lower()


@router.post("/logout")
def logout(request: Request, response: Response, sid: str | None = Cookie(default=None),
           conn=Depends(db_dep)):
    if sid and _same_origin(request):
        with conn.cursor() as cur:
            cur.execute("DELETE FROM session WHERE token = %s", (sid,))
            log_access(cur, username="?", action="logout", resource_type="session")
        response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.post("/change-password")
def change_password(body: PasswordChange, response: Response,
                    request: Request = Depends(_current_request),
                    sid: str | None = Cookie(default=None),
                    user=Depends(get_current_user), conn=Depends(db_dep)):
    """Self-service password change for ANY logged-in user (admin or official).
    Verifies the current password, sets the new one, and **rotates every session
    including this one** — a token stolen before the change must not survive the
    remediation (review 2026-11-15). The caller gets a fresh cookie."""
    assert_reauth_allowed(user["id"])
    check_password_policy(body.new_password)
    with conn.cursor() as cur:
        cur.execute("SELECT password_hash FROM user_account WHERE id = %s", (user["id"],))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="account not found")
        if not verify_pw(body.current_password, row["password_hash"]):
            note_reauth_failure(user["id"])
            raise HTTPException(status_code=400, detail="current password is incorrect")
        clear_reauth_failures(user["id"])
        if verify_pw(body.new_password, row["password_hash"]):
            raise HTTPException(status_code=400, detail="new password must differ from the current one")
        cur.execute(
            "UPDATE user_account SET password_hash = %s, "
            "  must_change_password = false WHERE id = %s",
            (hash_pw(body.new_password), user["id"]),
        )
        # Rotate ALL sessions for this user, the caller's included.
        cur.execute("DELETE FROM session WHERE user_id = %s", (user["id"],))
        token = secrets.token_urlsafe(32)
        cur.execute(
            "INSERT INTO session (token, user_id, expires_at) "
            "VALUES (%s, %s, now() + %s::interval)",
            (token, user["id"], _session_ttl_sql()),
        )
    _attach_cookie(response, token)
    return {"ok": True, "must_change_password": False}


@router.get("/me")
def me(request: Request, user=Depends(get_current_user)):
    return _user_public(user, request)
