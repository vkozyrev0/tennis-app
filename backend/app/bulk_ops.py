"""Per-row failure isolation for bulk writes (improvement-plan P2 #10).

In Postgres, the FIRST failed statement aborts the whole transaction: every
later statement raises InFailedSqlTransaction, and the request-end COMMIT
silently becomes a rollback — so a loop that catches an error and "continues"
without a savepoint loses ALL its rows while still reporting success counts.
(imports.py and roster.py already used hand-rolled savepoints; this is the
shared helper for every other bulk loop.)

Usage:
    try:
        with savepoint(cur):
            cur.execute(...)        # the per-row writes
    except psycopg.Error as e:
        skipped.append(...)         # tx is healthy; the loop continues
"""
from contextlib import contextmanager


@contextmanager
def savepoint(cur, name: str = "bulk_row"):
    """Run the body inside SAVEPOINT `name`. On success the savepoint is
    released; on ANY exception it rolls back to the savepoint (restoring a
    healthy transaction) and re-raises for the caller to record."""
    cur.execute(f"SAVEPOINT {name}")
    try:
        yield
    except BaseException:
        cur.execute(f"ROLLBACK TO SAVEPOINT {name}")
        raise
    else:
        cur.execute(f"RELEASE SAVEPOINT {name}")
