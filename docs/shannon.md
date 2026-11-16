# Shannon (external AI pentester) — install, patch, upgrade

Shannon is Keygraph's autonomous AI pentester. It is **not part of this repo**:
it is an external, AGPL-3.0 tool that we run against a disposable copy of the
app. This page records how it is installed here, the one local patch it needs,
why that patch exists, and the runbook for taking a newer version.

- Upstream: <https://github.com/KeygraphHQ/shannon>
- Licence: AGPL-3.0 (upstream does not accept external PRs; issues are open)
- Version used for the 2026-11-15 review: **3.5.1** (`keygraph/shannon:3.5.1`)
- Model used: `deepseek:deepseek-flash` (DeepSeek V4.1 Flash), agentic SAST on
- Findings and fixes: [security-review-2026-11-15.md](security-review-2026-11-15.md)

## What is installed, and where

| Piece | Location | Notes |
| --- | --- | --- |
| Agent skill (docs entry point) | `~/.config/opencode/skills/shannon/` | `SKILL.md` + the plugin's `llms.txt` / `llms-full.txt`, copied from the upstream plugin |
| CLI | npm cache (`~/.npm/_npx/<hash>/node_modules/@keygraph/shannon`) | installed on demand by `npx @keygraph/shannon@latest`; the npx cache dir changes when the version changes |
| Node 22+ | `/opt/node` inside WSL Ubuntu | prerequisite; Windows Node does not run the CLI (see below) |
| Worker image | `keygraph/shannon:<version>` | pulled on first run; removed in the post-review cleanup, re-pulled automatically |
| Reports | `~/.shannon/workspaces/<workspace>/` | `Security-Assessment-Report.{md,pdf}`, `report.sarif`, `report.json` |

Shannon runs on Windows **only through WSL2** (upstream: "Native Windows,
including Git Bash, is not supported"). Everything below assumes commands are
executed inside the Ubuntu distro.

## Prerequisites (what actually had to be enabled)

1. **Docker Desktop → Settings → General → "Use the WSL 2 based engine"** — that
   is the engine running in `docker-desktop`, not access from your distro.
2. **Docker Desktop → Settings → Resources → WSL Integration → Ubuntu** — this
   is the one that produces `/var/run/docker.sock` inside Ubuntu. With it off,
   the CLI cannot reach the daemon from WSL at all (the previous workaround was
   a `socat` TCP bridge; it has been removed).
3. Shannon refuses to run as **root**; run it as the normal WSL user.
4. A model credential in the environment (`SHANNON_AI_MODEL`, `SHANNON_AI_API_KEY`)
   or a saved `~/.shannon/config.toml` from `npx @keygraph/shannon setup`
   (interactive — run that yourself, never paste keys into a chat).

## The one local patch, and why

`scripts/patch_shannon_mount.py` changes Shannon's worker-container start from
a read-only repository mount to a read-write one:

```diff
- args.push("-v", `${opts.repo.hostPath}:${opts.repo.containerPath}:ro`);
+ args.push("-v", `${opts.repo.hostPath}:${opts.repo.containerPath}:rw`);
```

### What breaks without it

Shannon mounts the repository read-only and then mounts four writable
directories *inside* it (`<repo>/.shannon/{deliverables,scratchpad,.playwright-cli}`
and `<repo>/.playwright`). Docker must create a mount point for each nested
mount with `mkdirat(2)` inside the parent mount. A read-only parent returns
`EROFS`, and runc aborts:

```
error mounting ".../.playwright" to rootfs at "/repos/app/.playwright":
create mountpoint ...: mkdirat /var/lib/docker/overlay2/<id>/merged/repos/app/.playwright:
read-only file system
```

### Evidence

- Reproduced here on Engine **29.9.3** (Docker Desktop 4.99.0), independent of
  WSL: the same two-mount shape fails, `:rw` works.
- The mechanism is documented by Docker: *"you mount another folder under mount
  point of the bind mount [and] an empty folder is created in the bind mounted
  folder. Which can't be created when the parent is read-only"* —
  <https://forums.docker.com/t/fail-to-setup-read-only-bind-mount-and-anonymous-volume/139766>
- Engine 29 tightened read-only mounts (recursively read-only by default) and
  removed the old escape hatch: `bind-nonrecursive` now errors with
  *"use bind-recursive=disabled instead"* —
  <https://github.com/docker/cli/blob/v29.9.1/opts/mount.go>
- The same `read-only file system` mount-point failure is reported across other
  projects: <https://github.com/github/gh-aw-firewall/issues/8076>,
  <https://github.com/github/gh-aw/issues/55212>.
- Docker Desktop had a *different* nested-mount regression in 4.67/29.3.1
  (macOS, "second mount is empty"), closed as a duplicate and fixed —
  <https://github.com/docker/desktop-feedback/issues/279>. It is not this bug.

Tested alternatives that **do not** work:

| Mount shape | Result |
| --- | --- |
| `-v repo:/x:ro` + `-v pw:/x/.playwright` | fails (`mkdirat … read-only file system`) |
| `--mount type=bind,src=repo,dst=/x,readonly,bind-recursive=disabled` + nested | same failure |
| pre-creating the nested directory in the source, mounted `:ro` | same failure (`EROFS` is returned before `EEXIST`) |
| `-v repo:/x:rw` + nested | works |

### Decision logic

We mount the repository **read-write on a disposable copy**, rather than
building an overlay locally:

- The isolation boundary is the **staged copy**, not the mount flag. Every scan
  runs against an `rsync` snapshot of the repo (excluding `.git`, `node_modules`,
  `.venv`, caches), so an agent write — including Shannon's own pre-recon git
  checkpoint, upstream issue
  [#490](https://github.com/KeygraphHQ/shannon/issues/490) — can only touch the
  copy. The copy is diffed after the run and deleted afterwards.
- The upstream-correct fix is an **overlay mount** (repo as `lowerdir`, writable
  `upperdir`), which is what Shannon's own design note describes
  ([#273](https://github.com/KeygraphHQ/shannon/issues/273)). On Docker Desktop
  the lowerdir lives on the WSL/gRPC-FUSE backend, where overlayfs is fragile;
  and Shannon builds its own `docker run` arguments, so it would mean carrying a
  second, larger patch in a package we do not control — for no added protection
  over the copy boundary.
- Revisit this if the copy boundary disappears: Shannon in CI against a checkout
  you care about, or a repository too large to duplicate. Then the overlay (or
  an upstream fix) is worth the fragility.

## Upgrade runbook (taking a fresh version)

The patch lives in the **npx cache**, so a version bump brings an unpatched copy
and the worker container will fail to start. Always:

```bash
# 1. Pull and run the new version once to populate the cache (preflight only).
wsl -d Ubuntu -- bash -lc 'npx --yes @keygraph/shannon@latest version'

# 2. Re-apply the mount patch. `--check` exits 1 when the patch is needed and
#    also when a new version changed the source layout (it then prints the
#    relevant lines for manual review).
wsl -d Ubuntu -- python3 scripts/patch_shannon_mount.py --check
wsl -d Ubuntu -- python3 scripts/patch_shannon_mount.py

# 3. Prove the credential/model resolve before paying for a scan.
wsl -d Ubuntu -- bash -lc 'npx --yes @keygraph/shannon@latest start \
  -u http://host.docker.internal:8000 -r /path/to/staged/copy --validate-model'
```

`patch_shannon_mount.py` is idempotent, keeps a one-time `.orig-backup` next to
the file, and supports `--revert` to restore the read-only mount (useful when a
future Shannon release fixes this upstream — check the diff before re-applying).

To force a clean re-download (corrupt cache, or the CLI behaves unexpectedly):

```bash
rm -rf ~/.npm/_npx                       # next npx re-fetches the package
rm -f  ~/.shannon/workspaces/<old-ws>/  # only if you no longer need the report
```

### Refreshing the bundled skill docs

The agent skill is a copy of the upstream plugin, so refresh it when you upgrade
(`SKILL.md` points at the bundled documentation):

```bash
cd ~/.config/opencode/skills/shannon
curl -fsSLO https://raw.githubusercontent.com/KeygraphHQ/shannon/main/plugins/shannon/skills/shannon/SKILL.md
curl -fsSLO https://raw.githubusercontent.com/KeygraphHQ/shannon/main/llms.txt
curl -fsSLO https://raw.githubusercontent.com/KeygraphHQ/shannon/main/llms-full.txt
```

`SKILL.md`'s relative links (`../../llms.txt`) are rewritten to `llms.txt` in the
local copy; re-apply that two-line change if you overwrite the file.

## How a scan is run here

```bash
# Target: the local Docker stack on this machine. Never a production host.
docker compose up -d --build --wait web          # app on :8000, demo seed

# Stage a disposable copy — this is the isolation boundary.
rsync -a --delete --exclude .git --exclude node_modules --exclude .venv \
      --exclude __pycache__ --exclude .playwright --exclude .shannon \
      /path/to/repo/ ~/repos/scan-target/

# Scan (config carries auth + rules of engagement; secrets stay in env).
export SHANNON_AI_MODEL=deepseek:deepseek-flash
export SHANNON_AI_API_KEY=…        # never commit, never paste into chat
npx --yes @keygraph/shannon@latest start \
  -u http://host.docker.internal:8000 \
  -r ~/repos/scan-target \
  -c ~/shannon-config.yaml \
  -w review-<date> --follow
```

Notes that cost us time and are worth keeping:

- `host.docker.internal`, not `localhost`, is how the worker container reaches
  the app.
- The config file must live on the WSL filesystem (a `-v` of a *file* on
  `/mnt/c` can surface as a directory).
- `--validate-auth` before a full run confirms the login flow in ~30 s.
- `--follow` makes the CLI exit with the scan outcome, which is what CI wants.
- One model runs the whole scan; DeepSeek Flash completed a 26-finding pass in
  ~78 minutes for roughly $0.50 of API spend.

## Guardrails

- Only scan systems you own or have written authorisation to test, and only
  non-production ones. Shannon **executes exploits** and mutates data.
- Never run `reset` (wipes all scan state); `stop` only for a scan you started.
- `setup` is interactive: run it in your own terminal.
- Keep the model key in the environment or `~/.shannon/config.toml`, never in
  the repo.
- Reports require human review; an empty report is not proof of security.
