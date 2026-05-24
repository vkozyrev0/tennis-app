"""Tiny SQL migration runner for the CourtOps POC.

Creates the target database if needed, then applies any *.sql files in
migrations/ that haven't been applied yet (tracked in schema_migrations).

Usage (from backend/):  python migrate.py
"""
import sys
from pathlib import Path

import psycopg

from app.config import settings

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def ensure_database() -> None:
    """CREATE DATABASE <target> if it doesn't already exist."""
    with psycopg.connect(settings.admin_dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s", (settings.dbname,)
            )
            if cur.fetchone() is None:
                # dbname is from config, not user input; quote defensively.
                cur.execute(f'CREATE DATABASE "{settings.dbname}"')
                print(f"created database {settings.dbname!r}")
            else:
                print(f"database {settings.dbname!r} already exists")


def apply_migrations() -> int:
    """Apply pending migrations in filename order. Returns count applied."""
    applied_count = 0
    with psycopg.connect(settings.dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version    text PRIMARY KEY,
                    applied_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT version FROM schema_migrations")
            done = {r[0] for r in cur.fetchall()}

        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            version = path.name
            if version in done:
                print(f"skip    {version}")
                continue
            sql = path.read_text(encoding="utf-8")
            with conn.cursor() as cur:
                cur.execute(sql)
                cur.execute(
                    "INSERT INTO schema_migrations (version) VALUES (%s)", (version,)
                )
            conn.commit()
            applied_count += 1
            print(f"applied {version}")
    return applied_count


def main() -> None:
    try:
        ensure_database()
        n = apply_migrations()
        print(f"done — {n} migration(s) applied")
    except Exception as e:
        print(f"migration failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
