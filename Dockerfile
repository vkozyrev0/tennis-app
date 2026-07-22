# CourtOps Tennis — all-in-one POC image: PostgreSQL + the FastAPI server + the
# static frontend (uvicorn serves the SPA at /). One container, no compose.
#
# The demo database is SEEDED AT BUILD TIME and baked into the image, so the
# embedded DB already contains data the moment the container starts.
#
# Build:  docker build -t courtops:poc .
# Run:    docker run --rm -p 8000:8000 courtops:poc
#         → open http://localhost:8000  (admin / admin)
#
# This bakes the DB engine + data into the app image on purpose — it's a
# single-TD POC, not a production topology (see docs/design.md §11).
#
# Size: ~690MB. Levers used to get there from ~980MB (debian + full deps):
#   - postgres:16-ALPINE base (musl) — all deps ship musllinux wheels.
#   - multi-stage: the venv is built in a throwaway stage, so pip / the build
#     toolchain never land in the final image.
#   - runtime-only deps (requirements-runtime.txt = no pytest/httpx) + stripped
#     bytecode.
# The remaining bulk is the Postgres engine itself (~290MB) + the baked cluster,
# which are inherent to bundling the database in the image.

# ---- builder: assemble + strip the venv (runtime deps only) ----
FROM postgres:16-alpine AS builder
RUN apk add --no-cache python3 py3-pip
ENV VIRTUAL_ENV=/opt/venv PATH="/opt/venv/bin:$PATH"
RUN python3 -m venv "$VIRTUAL_ENV"
COPY backend/requirements-runtime.txt /tmp/req.txt
# --only-binary makes the build FAIL FAST if any dep lacks a musllinux wheel
# rather than try to compile (no toolchain here, on purpose).
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir --only-binary=:all: -r /tmp/req.txt \
    && pip uninstall -y pip wheel 2>/dev/null || true \
    && find "$VIRTUAL_ENV" -name '__pycache__' -type d -prune -exec rm -rf {} + \
    && find "$VIRTUAL_ENV" -name '*.pyc' -delete

# ---- final: postgres + bash + python runtime + the prebuilt venv ----
FROM postgres:16-alpine

# bash: the entrypoint is a bash script (Alpine ships only busybox sh).
# su-exec: entrypoint starts as root (Fly volume chown) then drops to postgres.
# No py3-pip here — the venv is copied in ready-to-run from the builder.
RUN apk add --no-cache python3 bash su-exec
ENV VIRTUAL_ENV=/opt/venv PATH="/opt/venv/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
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
# Fly persistent deploys override PGDATA to /data/pgdata (see fly.toml mounts).
ENV ENV=dev \
    PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
    PGDATABASE=courtops PGSSLMODE=disable \
    PGDATA=/opt/courtops/pgdata \
    SEED_SCRIPT=demo_seed.py \
    PORT=8000

RUN mkdir -p "$PGDATA" && chown -R postgres:postgres /app /opt/courtops

# Bake a pre-seeded database into the image (must run as postgres — initdb
# refuses root). Runtime starts as root so the entrypoint can chown a volume
# mount, then su-exec drops back to postgres for pg_ctl + uvicorn.
USER postgres

# Bake a pre-seeded database into the image: init the cluster, start it, apply
# migrations, load the realistic demo, stop it. The image now ships with data in
# its embedded DB — no first-run seeding needed (until a volume shadows PGDATA).
RUN set -eux; \
    initdb -D "$PGDATA" --username=postgres --auth-local=trust --auth-host=trust >/dev/null; \
    pg_ctl -D "$PGDATA" -o "-c listen_addresses=localhost -p 5432" -w -t 60 start; \
    (cd backend && python migrate.py && python "$SEED_SCRIPT"); \
    pg_ctl -D "$PGDATA" -m fast -w stop

USER root

EXPOSE 8000

# Readiness signal for plain `docker run` / the Caddy-VM path (Fly & Render define
# their own /api/health checks). Uses the venv Python's stdlib urllib — no curl,
# no extra apt package. start-period covers the cold-start migrate/seed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health').read()" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
