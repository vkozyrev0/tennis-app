#!/usr/bin/env python3
"""Fail when a current-status doc line disagrees with the tree.

The suite/file/module counts drifted three times (audit D15). `test-coverage.md`
holds the collected test count; this script checks every other current-status
line against it plus the live file/module/line counts. It does not re-run
pytest (collection would reset a test DB); update the one status line in
test-coverage.md after a real `pytest --collect-only -q`, then run this.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLLECTED = re.compile(r"(\d+) tests collected")


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def collected_count() -> int | None:
    """Run pytest collection (needs the test DB) and return the count."""
    out = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q"],
        cwd=ROOT / "backend", capture_output=True, text=True, check=False,
    )
    m = COLLECTED.search(out.stdout + out.stderr)
    return int(m.group(1)) if m else None


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    tests = len(list((ROOT / "backend" / "tests").glob("test_*.py")))
    frontend_tests = len(list((ROOT / "frontend" / "app").glob("*.test.mjs")))
    modules = len(list((ROOT / "frontend" / "app").glob("*.js")))
    app_lines = len(read("frontend/app.js").splitlines())
    migrations = sorted((ROOT / "backend" / "migrations").glob("*.sql"))
    migration = migrations[-1].stem.split("_")[0] if migrations else "?"

    coverage = read("docs/test-coverage.md")
    m = re.search(r"\*\*(\d+) tests\*\* collected", coverage)
    if not m:
        print("docs/test-coverage.md: no '**N tests** collected' status line")
        return 1
    count = m.group(1)
    if "--collect" in args:
        measured = collected_count()
        if measured is None:
            print("could not collect the suite count (is Postgres up?)")
            return 1
        count = str(measured)

    problems: list[str] = []

    def need(rel: str, pattern: str, what: str) -> None:
        if not re.search(pattern, read(rel)):
            problems.append(f"{rel}: missing {what}")

    need("docs/README.md", rf"\*\*{count}\*\* tests / \*\*{tests}\*\* files",
         f"{count} tests / {tests} files")
    need("docs/roadmap.md", rf"\*\*{count}\*\* tests / \*\*{tests}\*\* files",
         f"{count} tests / {tests} files")
    need("docs/design.md", rf"\({count} tests / {tests} files\)",
         f"({count} tests / {tests} files)")
    need("docs/design.md", rf"{app_lines} LOC", f"{app_lines} LOC")
    need("docs/design.md", rf"\*\*{modules}\*\* ESM", f"{modules} ESM modules")
    need("docs/test-coverage.md", rf"\({count} tests / {tests} files\)",
         f"({count} tests / {tests} files) in the run command")
    need("docs/test-coverage.md", rf"\*\*{count} tests\*\* across \*\*{tests}\*\* files",
         f"{count} tests across {tests} files")
    need("docs/test-coverage.md", rf"\*\*{count} tests\*\* collected",
         f"the **{count} tests** collected status line")
    need("docs/test-coverage.md",
         rf"{frontend_tests} `frontend/app/\*\.test\.mjs`",
         f"{frontend_tests} frontend test files")
    need("docs/test-coverage.md", rf"That is \*\*{frontend_tests}\*\* `frontend/app/\*\.test\.mjs`",
         f"That is **{frontend_tests}** frontend test files")
    need("docs/design.md", rf"\b{migration}\b", f"migration head {migration}")

    if problems:
        print("\n".join(problems))
        return 1
    print(
        f"docs counts agree: {count} tests / {tests} files / "
        f"{frontend_tests} frontend tests / {modules} modules / "
        f"{app_lines} app.js lines / migration {migration}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
