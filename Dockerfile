# CourtOps Tennis — all-in-one POC image: PostgreSQL + the FastAPI server + the
# static frontend (uvicorn serves the SPA at /). One container, no compose.
#
# The demo database is SEEDED AT BUILD TIME and baked into the image, so the
# embedded DB already contains data the moment the container starts.
#
# Build:  docker build -t courtops .
# Run:    docker run --rm -p 8000:8000 courtops
#         → open http://localhost:8000  (admin / admin)
#
# This bakes the DB engine + data into the app image on purpose — it's a
# single-TD POC, not a production topology (see docs/design.md §11).

FROM postgres:16-bookworm

# Python + venv (psycopg[binary]/cryptography/pillow ship manylinux wheels, so no
# compiler toolchain is needed).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r backend/requirements.txt

# App + frontend + entrypoint.
COPY backend  backend
COPY frontend frontend
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# Normalize line endings: a Windows checkout (autocrlf) can give the script CRLF,
# which breaks the `#!/usr/bin/env bash` shebang inside the container. Strip CRs
# so the image is correct regardless of the build host. (.gitattributes also
# pins *.sh to LF, but this keeps the image robust on its own.)
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

# POC defaults — these match backend/app/config.py, so nothing extra is needed.
# ENV=dev keeps the production boot-guard a no-op. PGDATA is a NON-volume path so
# the build-time-seeded cluster persists in the image layer (the postgres base
# image declares /var/lib/postgresql/data as a VOLUME, which would discard it).
ENV ENV=dev \
    PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
    PGDATABASE=courtops PGSSLMODE=disable \
    PGDATA=/opt/courtops/pgdata \
    SEED_SCRIPT=demo_seed.py \
    PORT=8000

RUN mkdir -p "$PGDATA" && chown -R postgres:postgres /app /opt/courtops

# Postgres refuses to run as root; the whole stack (build seed + runtime) is the
# `postgres` user.
USER postgres

# Bake a pre-seeded database into the image: init the cluster, start it, apply
# migrations, load the realistic demo, stop it. The image now ships with data in
# its embedded DB — no first-run seeding needed.
RUN set -eux; \
    initdb -D "$PGDATA" --username=postgres --auth-local=trust --auth-host=trust >/dev/null; \
    pg_ctl -D "$PGDATA" -o "-c listen_addresses=localhost -p 5432" -w -t 60 start; \
    (cd backend && python migrate.py && python "$SEED_SCRIPT"); \
    pg_ctl -D "$PGDATA" -m fast -w stop

EXPOSE 8000

# Readiness signal for plain `docker run` / the Caddy-VM path (Fly & Render define
# their own /api/health checks). Uses the venv Python's stdlib urllib — no curl,
# no extra apt package. start-period covers the cold-start migrate/seed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health').read()" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
