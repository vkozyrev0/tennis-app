"""Test isolation: run the suite against a separate `courtops_test` database so
tests never pollute the working/demo `courtops` DB.

This must set PGDATABASE *before* anything imports app.config (whose Settings read
env at import time). pytest imports conftest.py before the test modules, so this
runs first. The test DB is DROPPED and recreated, migrated, and seeded once per
session — so every local run starts pristine, exactly like a fresh CI container.

Why the drop matters: `courtops_test` persists between local runs, so without a
reset its rows accumulate. Tests that create a fixed-name tournament then hit a
409 ("name already exists") on the second run, and count assertions drift as
unrelated rows pile up — the order-independent "flake" that only ever bit local
runs (CI spins up a clean Postgres each time, so it never saw it). Set
KEEP_TEST_DB=1 to skip the drop and inspect a failed run's data post-mortem.
"""
import os

os.environ["PGDATABASE"] = os.getenv("TEST_PGDATABASE", "courtops_test")

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import psycopg  # noqa: E402
import pytest  # noqa: E402

from app.config import settings  # noqa: E402

import migrate  # noqa: E402  (import after env is set)
import seed  # noqa: E402


def _reset_test_database() -> None:
    """Drop the test DB so the session starts from a clean schema+seed. Refuses
    to touch anything not clearly a test database — a misconfigured PGDATABASE
    must never drop the working `courtops` DB."""
    name = settings.dbname
    if not name.endswith("_test"):
        raise RuntimeError(
            f"refusing to reset {name!r}: the test DB name must end in '_test' "
            "(check PGDATABASE / TEST_PGDATABASE)"
        )
    with psycopg.connect(settings.admin_dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            # Boot any lingering backends (e.g. a crashed prior run) so DROP
            # isn't blocked, then drop. Recreated by migrate.main() below.
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (name,),
            )
            cur.execute(f'DROP DATABASE IF EXISTS "{name}"')


if not os.getenv("KEEP_TEST_DB"):
    _reset_test_database()

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
