"""Test isolation: run the suite against a separate `courtops_test` database so
tests never pollute the working/demo `courtops` DB.

This must set PGDATABASE *before* anything imports app.config (whose Settings read
env at import time). pytest imports conftest.py before the test modules, so this
runs first. The test DB is created, migrated, and seeded once per session.
"""
import os

os.environ["PGDATABASE"] = os.getenv("TEST_PGDATABASE", "courtops_test")

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402

import migrate  # noqa: E402  (import after env is set)
import seed  # noqa: E402

migrate.main()  # create + migrate courtops_test
seed.main()     # idempotent seed (rates, sites, demo tournament)


@pytest.fixture(autouse=True)
def _reset_login_throttle():
    """Test isolation for the login rate-limiter.

    `app.routers.auth` keeps per-(client_ip, username) failed-attempt counts +
    lockouts in PROCESS-GLOBAL dicts. Under the test client every request shares
    one host, so the many tests that POST a wrong `admin` password can leave
    failure state (or a lockout) for the ("testclient", "admin") key that bleeds
    into a LATER, unrelated test: its autouse `admin/admin` login then returns 429
    instead of setting a session cookie, and the test fails with a misleading 401
    on some downstream request. This was the intermittent, order-independent flake
    (it passed in isolation because the state never accumulated).

    Clearing the throttle before every test makes each test's auth state
    independent — no product behaviour changes, only cross-test leakage is removed.
    """
    from app.routers import auth
    auth._attempts.clear()
    auth._locked_until.clear()
    yield
