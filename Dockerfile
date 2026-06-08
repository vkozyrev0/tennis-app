# CourtOps Tennis — all-in-one POC image: PostgreSQL + the FastAPI server + the
# static frontend (uvicorn serves the SPA at /). One container, no compose.
#
# Build:  docker build -t courtops .
# Run:    docker run --rm -p 8000:8000 courtops
#         → open http://localhost:8000  (admin / admin)
#
# This bakes the DB engine into the app image on purpose — it's a single-TD POC,
# not a production topology. For real deployments, split DB and app and drop the
# bundled Postgres (see docs/design.md §11).

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
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R postgres:postgres /app

# POC defaults — these match backend/app/config.py, so nothing extra is needed.
# ENV=dev keeps the production boot-guard a no-op (it would otherwise refuse the
# default superuser creds / non-TLS). Override at `docker run -e ...` to harden.
ENV ENV=dev \
    PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
    PGDATABASE=courtops PGSSLMODE=disable \
    SEED_SCRIPT=demo_seed.py \
    PORT=8000

EXPOSE 8000

# Postgres refuses to run as root; the whole stack runs as the `postgres` user.
USER postgres
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
