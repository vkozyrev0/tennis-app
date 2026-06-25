#!/usr/bin/env bash
# All-in-one POC entrypoint: bring up the bundled Postgres, migrate + seed, then
# run the API/frontend in the foreground (so the container's life == uvicorn's).
set -euo pipefail

export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PORT="${PORT:-8000}"

first_init=0
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[entrypoint] initializing PostgreSQL cluster in $PGDATA ..."
  # Local-only POC: trust auth on the loopback socket/TCP. The DB never listens
  # outside the container (listen_addresses=localhost below), so this stays in.
  initdb -D "$PGDATA" --username=postgres --auth-local=trust --auth-host=trust >/dev/null
  first_init=1
fi

echo "[entrypoint] starting PostgreSQL ..."
pg_ctl -D "$PGDATA" -o "-c listen_addresses=localhost -p 5432" -w -t 60 start

# Belt-and-suspenders readiness wait.
until pg_isready -h localhost -p 5432 -q; do sleep 1; done

# Make the password explicit too, so flipping PGSSLMODE/auth to md5 later works.
psql -h localhost -U postgres -d postgres -qc "ALTER ROLE postgres WITH PASSWORD 'postgres';" >/dev/null

cd /app/backend
echo "[entrypoint] applying migrations ..."
python migrate.py

# Seed the demo only on a fresh cluster (so data survives a container restart),
# unless DEMO_RESEED=1 forces it. SEED_SCRIPT=demo_seed.py (rich live demo) by
# default; set SEED_SCRIPT=seed.py for just the lean baseline.
if [ "$first_init" = "1" ] || [ "${DEMO_RESEED:-0}" = "1" ]; then
  echo "[entrypoint] loading demo data (${SEED_SCRIPT:-demo_seed.py}) ..."
  python "${SEED_SCRIPT:-demo_seed.py}"
else
  echo "[entrypoint] existing data found — skipping seed (set DEMO_RESEED=1 to reload)"
fi

# Harden the admin login: when ADMIN_PASSWORD is set, (re)apply it on every boot
# so it works even on the baked image where seeding is skipped, and so a redeploy
# rotates it. Unset => the POC default (admin/admin) stays as seeded.
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "[entrypoint] applying ADMIN_PASSWORD to the admin account ..."
  python - <<'PY'
import os
from app.db import get_conn
from app.security import hash_pw

conn = get_conn()
try:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO user_account (username, password_hash, role) "
            "VALUES ('admin', %s, 'admin') "
            "ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash",
            (hash_pw(os.environ["ADMIN_PASSWORD"]),),
        )
    conn.commit()
finally:
    conn.close()
PY
fi

echo "[entrypoint] serving API + frontend on 0.0.0.0:$PORT  (sign in: admin / admin)"
# Run uvicorn as a child (not exec) and trap SIGTERM so a `docker stop` / Fly
# scale-to-zero shuts the bundled Postgres down CLEANLY before the container dies.
# Without this, only uvicorn (PID 1) gets the signal and Postgres is SIGKILLed,
# forcing slow WAL crash-recovery on the next start (and exit 255 noise).
shutdown() {
  echo "[entrypoint] SIGTERM — stopping uvicorn then Postgres ..."
  kill -TERM "$uvicorn_pid" 2>/dev/null || true
  wait "$uvicorn_pid" 2>/dev/null || true
  pg_ctl -D "$PGDATA" -m fast -w stop || true
}
trap shutdown TERM INT

uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --app-dir /app/backend &
uvicorn_pid=$!
wait "$uvicorn_pid"
