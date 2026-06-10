"""Per-row savepoint isolation for bulk writes (app/bulk_ops.py, plan P2 #10).

Documents the Postgres failure mode the helper exists for — after one failed
statement the WHOLE transaction is aborted (later statements raise
InFailedSqlTransaction and the request-end COMMIT silently rolls everything
back) — and proves the savepoint pattern keeps the transaction healthy so the
surviving rows actually commit."""
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.bulk_ops import savepoint
from app.db import get_conn
from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)

# An easy deterministic violation: certification_rate UNIQUE (cert_type,
# effective_from). Far-future dates so the cleanup can target them precisely.
_INS = ("INSERT INTO certification_rate (cert_type, rate_per_day, effective_from) "
        "VALUES ('referee_in_training', %s, %s)")


def _cleanup(conn):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM certification_rate "
                    "WHERE cert_type = 'referee_in_training' AND effective_from >= '2099-01-01'")
    conn.commit()


def test_without_savepoint_one_error_poisons_the_transaction():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(_INS, (100, "2099-01-01"))
            with pytest.raises(psycopg.errors.UniqueViolation):
                cur.execute(_INS, (200, "2099-01-01"))      # duplicate -> tx aborted
            # The naive catch-and-continue pattern now fails on the NEXT row:
            with pytest.raises(psycopg.errors.InFailedSqlTransaction):
                cur.execute(_INS, (300, "2099-02-01"))
    finally:
        conn.rollback()
        conn.close()


def test_savepoint_isolates_the_failed_row_and_the_rest_commits():
    conn = get_conn()
    try:
        skipped = []
        with conn.cursor() as cur:
            for rate, eff in ((100, "2099-01-01"), (200, "2099-01-01"), (300, "2099-02-01")):
                try:
                    with savepoint(cur):
                        cur.execute(_INS, (rate, eff))
                except psycopg.Error as e:
                    skipped.append((rate, type(e).__name__))
        conn.commit()                                        # the request-end commit
        assert skipped == [(200, "UniqueViolation")]         # only the dup skipped
        with conn.cursor() as cur:                           # survivors really persisted
            cur.execute("SELECT rate_per_day FROM certification_rate "
                        "WHERE cert_type = 'referee_in_training' "
                        "AND effective_from >= '2099-01-01' ORDER BY effective_from")
            assert [float(r["rate_per_day"]) for r in cur.fetchall()] == [100.0, 300.0]
    finally:
        _cleanup(conn)
        conn.close()
