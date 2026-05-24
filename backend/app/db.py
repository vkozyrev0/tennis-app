"""Database access helpers (psycopg 3)."""
import psycopg
from psycopg.rows import dict_row

from .config import settings


def get_conn() -> psycopg.Connection:
    """Open a new connection that returns rows as dicts."""
    return psycopg.connect(settings.dsn, row_factory=dict_row)


def db_dep():
    """FastAPI dependency: a per-request connection, committed on success."""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
