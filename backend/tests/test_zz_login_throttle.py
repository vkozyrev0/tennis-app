"""Login throttling (D22): per-user key plus a global per-IP bucket.

A sprayer rotates usernames to stay under the 5-failure per-key cap, and in a
proxied deployment every client can share one IP. Both buckets must trip, and a
successful login must not hand the sprayer a reset by clearing the IP bucket.
"""
import pytest
from fastapi import HTTPException

from app.routers import auth

_IP = "203.0.113.10"


def test_per_user_key_locks_after_five_failures():
    key = (_IP, "admin")
    for _ in range(auth._FAIL_LIMIT):
        auth._record_fail(key, _IP)
    with pytest.raises(HTTPException) as ei:
        auth._check_lock(key, _IP)
    assert ei.value.status_code == 429


def test_username_rotation_trips_the_per_ip_cap():
    for i in range(auth._IP_FAIL_LIMIT):
        auth._record_fail((_IP, f"probe{i}"), _IP)
    with pytest.raises(HTTPException) as ei:
        auth._check_lock((_IP, "admin"), _IP)
    assert ei.value.status_code == 429

    other = "203.0.113.11"
    auth._check_lock((other, "admin"), other)  # a different client is unaffected


def test_success_clears_only_the_user_key():
    key = (_IP, "admin")
    auth._record_fail(key, _IP)
    auth._clear_attempts(key)
    assert key not in auth._attempts
    assert auth._ip_attempts[_IP], "one valid login must not reset the IP bucket"


def test_expired_ip_lock_is_cleared():
    auth._ip_locked_until[_IP] = 0.0
    auth._ip_attempts[_IP] = [0.0]
    auth._check_lock((_IP, "admin"), _IP)
    assert _IP not in auth._ip_locked_until
    assert _IP not in auth._ip_attempts
