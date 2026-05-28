"""Login / logout / me — cookie-session auth (POC)."""
import os
import secrets
import time
from collections import defaultdict
from threading import Lock

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response

from ..db import db_dep
from ..models import LoginIn
from ..security import COOKIE_NAME, get_current_user, verify_pw

router = APIRouter(prefix="/api/auth", tags=["auth"])


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
    """HTTPS-only cookies in prod; off for localhost dev so browsers accept them."""
    return os.getenv("COURTOPS_SECURE_COOKIE", "").lower() in {"1", "true", "yes"}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, conn=Depends(db_dep)):
    client_ip = request.client.host if request.client else "?"
    key = (client_ip, (body.username or "").strip().lower())
    _check_lock(key)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, username, password_hash, role, official_id "
            "FROM user_account WHERE username = %s",
            (body.username,),
        )
        user = cur.fetchone()
        if user is None or not verify_pw(body.password, user["password_hash"]):
            _record_fail(key)
            raise HTTPException(status_code=401, detail="invalid username or password")
        # Successful auth — rotate any pre-existing token for this user (defends
        # against session fixation) and start fresh.
        cur.execute("DELETE FROM session WHERE expires_at <= now()")  # opportunistic cleanup
        cur.execute("DELETE FROM session WHERE user_id = %s", (user["id"],))
        token = secrets.token_urlsafe(32)
        cur.execute(
            "INSERT INTO session (token, user_id, expires_at) "
            "VALUES (%s, %s, now() + interval '30 days')",
            (token, user["id"]),
        )
    _clear_attempts(key)
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, samesite="strict", path="/",
        secure=_secure_cookie(),
    )
    return {"username": user["username"], "role": user["role"], "official_id": user["official_id"]}


@router.post("/logout")
def logout(response: Response, sid: str | None = Cookie(default=None), conn=Depends(db_dep)):
    if sid:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM session WHERE token = %s", (sid,))
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(user=Depends(get_current_user)):
    return {"username": user["username"], "role": user["role"], "official_id": user["official_id"]}
