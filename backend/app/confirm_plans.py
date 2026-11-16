"""Server-side confirmation plans for the TD chat executor (AUTHZ-10).

The executor used to trust ``confirm: true`` in the request body: the same
request that planned a destructive call could approve it, so a stolen session
never needed a second decision. A plan is now minted here when the server
proposes mutating calls, bound to the authenticated user, the tournament and the
exact calls, with a short TTL. ``POST /api/td-chat/execute`` with ``confirm``
must present that token and the same calls, so the approval is a server record
rather than a client claim.

In-process and per-worker, like job_progress: a multi-worker deployment needs a
shared store (table or Redis). Tokens are single-use and bounded in count.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from threading import Lock

_TTL_S = 600
_MAX_PLANS = 500
_lock = Lock()
_plans: dict[str, dict] = {}


def _fingerprint(calls: list[dict] | None) -> str:
    """Stable hash of the calls a plan covers (order-sensitive, values included)."""
    norm = [
        {"tool": (c.get("tool") or "").strip(), "args": c.get("args") or {}}
        for c in (calls or [])
    ]
    blob = json.dumps(norm, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


def mint(username: str, tournament_id: int | None, calls: list[dict]) -> str:
    """Record a pending plan and return its single-use token."""
    now = time.monotonic()
    token = secrets.token_urlsafe(24)
    with _lock:
        # Cheap GC: drop expired entries before adding.
        for k, v in list(_plans.items()):
            if now - v["minted"] > _TTL_S:
                _plans.pop(k, None)
        if len(_plans) >= _MAX_PLANS:
            oldest = min(_plans, key=lambda k: _plans[k]["minted"])
            _plans.pop(oldest, None)
        _plans[token] = {
            "username": username,
            "tournament_id": tournament_id,
            "fingerprint": _fingerprint(calls),
            "minted": now,
        }
    return token


def consume(token: str | None, username: str, tournament_id: int | None,
            calls: list[dict] | None) -> bool:
    """True when `token` authorizes exactly these calls for this user, once."""
    if not token:
        return False
    now = time.monotonic()
    with _lock:
        plan = _plans.get(token)
        if plan is None:
            return False
        if now - plan["minted"] > _TTL_S:
            _plans.pop(token, None)
            return False
        if plan["username"] != username:
            return False
        if plan["tournament_id"] != tournament_id:
            return False
        if plan["fingerprint"] != _fingerprint(calls):
            return False
        _plans.pop(token, None)  # single use
        return True
