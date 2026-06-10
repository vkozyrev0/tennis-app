"""_rate_for fallback semantics (investigation 2026-06-10).

When NO rate was effective on the work date (work logged before the rate
catalog starts), the fallback must pick the EARLIEST known rate — the one
nearest that early work date — not the newest. Runs inside a rolled-back
transaction so the shared rate catalog is untouched."""
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.db import get_conn
from app.main import app
from app.routers.assignments import _rate_for

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


def test_pre_catalog_work_uses_earliest_rate_and_on_date_uses_effective():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # Isolated catalog for one cert type: wipe + two future rates.
            cur.execute("DELETE FROM certification_rate WHERE cert_type = 'referee_in_training'")
            cur.execute(
                "INSERT INTO certification_rate (cert_type, rate_per_day, effective_from) "
                "VALUES ('referee_in_training', 300, '2099-01-01'), "
                "       ('referee_in_training', 400, '2099-06-01')")
            # Work BEFORE any rate exists -> the earliest (300), not the newest (400).
            assert _rate_for(cur, "referee_in_training", date(2098, 1, 1)) == 300.0
            # Work ON/AFTER an effective date -> the rate in effect that day.
            assert _rate_for(cur, "referee_in_training", date(2099, 3, 1)) == 300.0
            assert _rate_for(cur, "referee_in_training", date(2099, 7, 1)) == 400.0
    finally:
        conn.rollback()   # leave the shared catalog exactly as it was
        conn.close()
