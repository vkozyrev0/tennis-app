# Deploying the all-in-one POC image

The whole POC — PostgreSQL **server**, FastAPI API, and the static frontend —
ships as one image (`Dockerfile`, `FROM postgres:16-bookworm`). One container
runs the bundled Postgres *and* uvicorn; the demo DB is baked in at build time.
This is a single-TD POC topology, not production (see `design.md` §11).

## 1. Publish the image to GitHub Container Registry (ghcr.io)

**CI does this automatically.** `.github/workflows/docker.yml` builds the image on
every push/PR and **pushes `ghcr.io/<owner>/tennis-app:latest` (+ a `sha-` tag) on
every push to `main` and on `v*` tags** — using the built-in `GITHUB_TOKEN`, so no
PAT or `docker login` is needed. After the first successful run, make the package
public if you want hosts to pull it without a token (GitHub → your profile →
**Packages** → `tennis-app` → **Package settings** → *Change visibility* → Public).

The manual steps below are only needed to push an image **from your laptop** (e.g.
before CI is set up, or to publish an off-`main` build).

The local `gh` token needs the `write:packages` scope (the default scopes don't
include it). Grant it once — this opens a browser/device-code flow:

```bash
gh auth refresh -h github.com -s write:packages,read:packages
```

Then log Docker in, tag, and push:

```bash
gh auth token | docker login ghcr.io -u vkozyrev0 --password-stdin
docker tag courtops:poc ghcr.io/vkozyrev0/tennis-app:latest
docker push ghcr.io/vkozyrev0/tennis-app:latest
```

Optionally make the package public (so hosts pull without a token) and link it to
the repo: GitHub → your profile → **Packages** → `tennis-app` → **Package
settings** → *Change visibility* → Public, and *Connect repository*.

## 2. HTTPS on 443 with a valid certificate

Don't put port 443 or a cert inside the container — terminate TLS at the edge and
keep the container on plain HTTP (`:8000`). A browser-trusted cert needs a domain
+ a CA (Let's Encrypt); you can't get one for a bare IP. Two paths:

- **Managed platform (easiest):** Render / Fly.io serve the container over HTTPS
  on 443 automatically, with a valid cert, on their own subdomain
  (`*.onrender.com`, `*.fly.dev`) — and on a custom domain if you add one.
- **Own VM:** put **Caddy** in front (see `Caddyfile`); it auto-obtains and
  renews a Let's Encrypt cert for your domain and proxies to `:8000`.

## 3. Host it (config files in the repo root)

### Fly.io — `fly.toml` (persistent DB, scale-to-zero)

`fly.toml` is set to **build from the Dockerfile on Fly's remote builder**, so you
don't need to push to ghcr first (skip Part 1). The first build takes a few minutes
because it bakes the demo DB.

```bash
fly auth login
fly launch --no-deploy --copy-config --name courtops-poc   # registers the app
fly volume create courtops_data --size 1 --region iad      # persistent DB (1 GB)
fly secrets set ADMIN_PASSWORD='choose-a-strong-one'       # harden the login
fly deploy                                                 # builds from Dockerfile + runs
fly open                                                   # -> https://courtops-poc.fly.dev
```
HTTPS on 443 with a valid cert is automatic on `*.fly.dev`. The `ADMIN_PASSWORD`
secret is applied when the fresh volume seeds on first boot, and re-applied on every
boot thereafter.

To deploy a **prebuilt ghcr image** instead (Route A), do Part 1, swap the
`[build]` block in `fly.toml` to `image = "ghcr.io/vkozyrev0/tennis-app:latest"`
(make the package public so Fly can pull it), and `fly deploy --image …`.

### Render — `render.yaml`
Point a Blueprint at the repo, or deploy the prebuilt image directly. Automatic
HTTPS on `https://courtops-poc.onrender.com`. The persistent `disk` in the
blueprint requires a paid instance; on the free tier remove the `disk:` block and
the DB resets to the baked demo on each restart.

### Own VM — `Caddyfile`
Run the container with a named volume, then run Caddy (see the header comments in
`Caddyfile` for the exact commands).

## 4. The embedded-DB persistence gotcha

The image bakes the seeded cluster into `/opt/courtops/pgdata` (a non-volume path,
because the postgres base image declares `/var/lib/postgresql/data` as a VOLUME
that would discard build-time writes).

- **No volume mounted** → the baked demo is served, and every restart resets to
  that clean demo state. Good for a pure demo (and for `docker run --rm`).
- **Volume mounted at `/opt/courtops/pgdata`** (Fly volume, Render disk, Docker
  named volume) → the mount *shadows* the baked data. A **fresh** volume is empty,
  so the entrypoint runs `initdb` + migrations + seeds the demo into it on first
  boot; after that, your edits persist across restarts/redeploys.

Force a reseed at any time with `DEMO_RESEED=1`. Use `SEED_SCRIPT=seed.py` for the
lean baseline instead of the rich demo.

## 5. Before exposing it publicly

It ships with `admin / admin` and a bundled single-container DB — POC only.

- **Harden the admin login** with the `ADMIN_PASSWORD` env var / secret. When set,
  it overwrites the admin password (so a redeploy rotates it) and is applied on
  first-boot seeding *and* re-applied on every boot — so it works on the baked
  image too, not just a fresh volume. Unset keeps the `admin/admin` POC default.
- Keep deployments short-lived/unlisted while it's a demo.
- For anything real, split out a managed Postgres (point the `PG*` env vars at it)
  per `design.md` §11 rather than relying on the bundled DB.
