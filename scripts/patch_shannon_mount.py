#!/usr/bin/env python3
"""Keep Shannon's worker container startable on Docker Engine 29+.

Shannon mounts the target repository read-only and then mounts four writable
directories *inside* it (`<repo>/.shannon/{deliverables,scratchpad,.playwright-cli}`
and `<repo>/.playwright`). Docker creates a mount point for every nested mount
with mkdirat(2) on the container's merged rootfs; doing that inside a read-only
bind mount returns EROFS and runc aborts the container:

    error mounting ".../.playwright" to rootfs at "/repos/app/.playwright":
    create mountpoint ...: mkdirat
    /var/lib/docker/overlay2/<id>/merged/repos/app/.playwright:
    read-only file system

Engine 29 makes the situation stricter (a `readonly` mount is recursively
read-only by default) and the old `bind-nonrecursive` escape hatch now errors;
`bind-recursive=disabled` does not help either, because the failure happens
while *creating* the mount point, before submount semantics matter.

Our decision (docs/shannon.md): mount the repository read-write. The isolation
boundary is the disposable copy of the repository that the scan runs against,
not this mount flag. The scan writes `.shannon/` and `.playwright/` into that
copy only, and the copy is deleted afterwards.

Re-run this after every Shannon upgrade — `npx @keygraph/shannon@latest` drops a
new copy into the npm cache, and an unpatched copy fails at container start.
The script fails loudly if Shannon's source no longer matches either pattern,
so a silent no-op cannot happen on a new layout.

Usage (inside WSL, where the scan runs):

    wsl -e python3 scripts/patch_shannon_mount.py --check   # exit 1 if a patch is needed
    wsl -e python3 scripts/patch_shannon_mount.py           # apply (idempotent)
    wsl -e python3 scripts/patch_shannon_mount.py --revert  # restore the read-only mount
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# The exact `spawnWorker` line in @keygraph/shannon's dist/index.mjs.
RO = 'args.push("-v", `${opts.repo.hostPath}:${opts.repo.containerPath}:ro`);'
RW = 'args.push("-v", `${opts.repo.hostPath}:${opts.repo.containerPath}:rw`);'
BACKUP = ".orig-backup"


def cache_roots(home: Path) -> list[Path]:
    """Every @keygraph/shannon install in the npx cache, newest first."""
    base = home / ".npm" / "_npx"
    if not base.is_dir():
        return []
    found = [
        p / "node_modules" / "@keygraph" / "shannon" / "dist" / "index.mjs"
        for p in base.iterdir()
    ]
    return sorted((p for p in found if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)


def status(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if RW in text and RO not in text:
        return "patched"
    if RO in text:
        return "needs-patch"
    return "unknown"


def apply_patch(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    backup = path.with_name(path.name + BACKUP)
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")
    path.write_text(text.replace(RO, RW), encoding="utf-8")


def revert(path: Path) -> bool:
    backup = path.with_name(path.name + BACKUP)
    if not backup.exists():
        return False
    path.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")
    return True


def hint(path: Path) -> None:
    print("  … the worker-start code no longer matches either pattern.")
    print("    Review these lines by hand before scanning:")
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if "opts.repo.hostPath" in line or "containerPath" in line:
                print(f"      {line.strip()[:160]}")
    except OSError as e:  # pragma: no cover - defensive
        print(f"      (could not read: {e})")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report only; exit 1 if a patch is needed")
    ap.add_argument("--revert", action="store_true", help="restore the read-only repo mount from the backup")
    ap.add_argument("--home", type=Path, default=Path.home(), help="home directory holding .npm (default: current user)")
    args = ap.parse_args(argv)

    installs = cache_roots(args.home)
    if not installs:
        print("No @keygraph/shannon install in the npx cache.")
        print("Run the scan once (npx @keygraph/shannon@latest start …) and re-run this script.")
        return 0

    worst = 0
    for path in installs:
        state = status(path)
        if args.revert:
            if revert(path):
                print(f"reverted: {path}")
                state = status(path)
            else:
                print(f"no backup to revert: {path}")
        elif state == "needs-patch":
            if args.check:
                print(f"NEEDS PATCH: {path}")
                worst = 1
            else:
                apply_patch(path)
                print(f"patched:  {path}")
                state = status(path)
        elif state == "unknown":
            print(f"UNKNOWN:  {path}")
            hint(path)
            worst = 1
        print(f"  repo mount: {state}")
    return worst


if __name__ == "__main__":
    sys.exit(main())
