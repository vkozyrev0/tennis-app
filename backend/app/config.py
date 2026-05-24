"""Environment-based configuration for the CourtOps POC.

Defaults target a localhost Postgres with the default admin user (POC only —
see docs/roadmap.md §Stack security note). Override via backend/.env or env vars.
"""
import os
from pathlib import Path

# Load backend/.env if python-dotenv is available (optional).
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except Exception:
    pass


class Settings:
    host: str = os.getenv("PGHOST", "localhost")
    port: str = os.getenv("PGPORT", "5432")
    user: str = os.getenv("PGUSER", "postgres")
    password: str = os.getenv("PGPASSWORD", "postgres")
    dbname: str = os.getenv("PGDATABASE", "courtops")
    # DB to connect to when creating the target database (must already exist).
    admin_dbname: str = os.getenv("PGADMIN_DB", "postgres")

    @property
    def dsn(self) -> str:
        return (
            f"host={self.host} port={self.port} dbname={self.dbname} "
            f"user={self.user} password={self.password}"
        )

    @property
    def admin_dsn(self) -> str:
        return (
            f"host={self.host} port={self.port} dbname={self.admin_dbname} "
            f"user={self.user} password={self.password}"
        )


settings = Settings()
