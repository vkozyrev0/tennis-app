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

import migrate  # noqa: E402  (import after env is set)
import seed  # noqa: E402

migrate.main()  # create + migrate courtops_test
seed.main()     # idempotent seed (rates, sites, demo tournament)
