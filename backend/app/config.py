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
    # Deployment environment. Anything outside the dev set is treated as a
    # shared/hosted deployment and triggers the security guard below.
    env: str = os.getenv("ENV", "dev")
    host: str = os.getenv("PGHOST", "localhost")
    port: str = os.getenv("PGPORT", "5432")
    user: str = os.getenv("PGUSER", "postgres")
    password: str = os.getenv("PGPASSWORD", "postgres")
    dbname: str = os.getenv("PGDATABASE", "courtops")
    # DB to connect to when creating the target database (must already exist).
    admin_dbname: str = os.getenv("PGADMIN_DB", "postgres")
    # libpq TLS mode. Default "prefer" = use TLS if the server offers it, else
    # fall back (safe for a local Postgres without SSL). Production must set
    # require / verify-ca / verify-full — enforced in validate().
    sslmode: str = os.getenv("PGSSLMODE", "prefer")

    # Email auto-ingest (D4). Read live from the environment so tests can
    # monkeypatch INGEST_TOKEN without reconstructing Settings. Empty = disabled
    # (POST /api/ingest/email returns 503).
    @property
    def ingest_token(self) -> str:
        return os.getenv("INGEST_TOKEN", "").strip()

    @property
    def ingest_enabled(self) -> bool:
        return bool(self.ingest_token)

    _DEV_ENVS = {"dev", "development", "local", "test", "ci"}
    _SECURE_SSLMODES = {"require", "verify-ca", "verify-full"}

    def is_prod(self) -> bool:
        # Read ENV live so tests can monkeypatch without reconstructing Settings
        # (same pattern as ingest_token / COURTOPS_* flags).
        return os.getenv("ENV", self.env).strip().lower() not in self._DEV_ENVS

    @property
    def dsn(self) -> str:
        return (
            f"host={self.host} port={self.port} dbname={self.dbname} "
            f"user={self.user} password={self.password} sslmode={self.sslmode}"
        )

    @property
    def admin_dsn(self) -> str:
        return (
            f"host={self.host} port={self.port} dbname={self.admin_dbname} "
            f"user={self.user} password={self.password} sslmode={self.sslmode}"
        )

    def validate(self) -> None:
        """Fail fast on insecure POC defaults outside dev (PII hardening H1 —
        see docs/pii-hardening-plan.md). No-op in dev/test so the local loop and
        the suite are unaffected; refuses to boot a shared/hosted deployment that
        still carries the default superuser creds or a non-TLS DB connection."""
        if not self.is_prod():
            return
        problems = []
        if self.user == "postgres" or self.password == "postgres":
            problems.append(
                "default Postgres superuser/password — set PGUSER/PGPASSWORD to a "
                "dedicated least-privilege role with a secret from the environment"
            )
        if self.sslmode.strip().lower() not in self._SECURE_SSLMODES:
            problems.append(
                f"PGSSLMODE={self.sslmode!r} does not enforce TLS — set "
                "require / verify-ca / verify-full"
            )
        from . import crypto  # local import: crypto pulls in `cryptography`
        if crypto.using_dev_key():
            problems.append(
                "PII_ENCRYPTION_KEY is the POC dev default — set a real Fernet key "
                "(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
            )
        if problems:
            raise RuntimeError(
                f"Refusing to start with ENV={self.env!r}: "
                + "; ".join(problems)
                + ". See docs/pii-hardening-plan.md §H1. (Set ENV=dev for local POC.)"
            )


settings = Settings()
