"""Wipe all demo data (schema kept) and re-seed the working DB.

Truncates every public table except `schema_migrations`, then runs the seed.
Targets `settings.dbname` (default `courtops`). Run from backend/:
    python reset_demo.py
"""
import psycopg

import seed
from app.config import settings


def main() -> None:
    with psycopg.connect(settings.dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
            )
            tables = [r[0] for r in cur.fetchall()]
            if tables:
                cur.execute(
                    "TRUNCATE TABLE "
                    + ", ".join(f'"{t}"' for t in tables)
                    + " RESTART IDENTITY CASCADE"
                )
    print(f"wiped {len(tables)} tables in {settings.dbname!r}: " + ", ".join(sorted(tables)))
    seed.main()


if __name__ == "__main__":
    main()
