"""Login user-enumeration defenses (POST /api/auth/login).

An attacker probing usernames must not be able to tell a nonexistent account
from a real one with a wrong password — neither by the response body NOR by
timing. The body is asserted here; the timing equalization (a missing user
still runs one PBKDF2 against a dummy hash) is verified by a loose lower-bound
on the unknown-user response time so a regression of that fix is caught.
"""
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


def test_unknown_user_and_wrong_password_return_identical_response():
    c = TestClient(app)
    r_unknown = c.post("/api/auth/login",
                       json={"username": "nobody_" + uuid.uuid4().hex, "password": "x"})
    r_wrong = c.post("/api/auth/login",
                     json={"username": "admin", "password": "definitely-not-it"})
    assert r_unknown.status_code == 401 and r_wrong.status_code == 401
    # Same generic detail — the body must not reveal which input was wrong.
    assert r_unknown.json()["detail"] == r_wrong.json()["detail"]


def test_unknown_user_still_pays_the_hash_cost():
    # Regression guard for the timing fix: a missing user runs PBKDF2 against a
    # dummy hash, so its 401 is in the same ballpark as a real-user wrong-password
    # 401 — NOT the near-instant short-circuit it would be without the fix.
    c = TestClient(app)

    def t(payload):
        best = min(_timed(c, payload) for _ in range(3))  # min = least noise
        return best

    unknown = t({"username": "ghost_" + uuid.uuid4().hex, "password": "x"})
    wrong = t({"username": "admin", "password": "nope"})
    # Without the dummy-hash verify, `unknown` would skip PBKDF2 entirely and be
    # a small fraction of `wrong`. Require it to be at least a third — lenient
    # enough for CI jitter, strict enough to catch the short-circuit regressing.
    assert unknown >= wrong / 3, f"unknown={unknown:.4f}s wrong={wrong:.4f}s (timing leak?)"


def _timed(c, payload):
    t0 = time.perf_counter()
    c.post("/api/auth/login", json=payload)
    return time.perf_counter() - t0
