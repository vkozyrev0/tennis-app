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

echo "[entrypoint] serving API + frontend on 0.0.0.0:$PORT  (sign in: admin / admin)"
# uvicorn becomes PID 1 so it gets SIGTERM directly on `docker stop`. The bundled
# Postgres is killed with the container; it crash-recovers on next start (fine for
# a POC, and the data volume is ephemeral with `docker run --rm`).
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --app-dir /app/backend
