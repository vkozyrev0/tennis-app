"""The DeepSeek key must never be committed (secret hygiene).

The small-LLM workload now runs on the DeepSeek API (``app/email_llm.py``), so
the repo has to prove it does not carry that credential. Two guards:

* the live value — read from ``DEEPSEEK_API_KEY`` and required to appear in no
  tracked file; skipped when the variable is not exported here.
* the shape — no tracked file may contain an ``sk-`` literal long enough to be
  a key, which catches a key pasted into code, a doc, or a fixture.

Both scan TRACKED files only: an untracked local ``backend/.env`` is exactly
where the key belongs. No test prints the value — only paths and counts.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
KEY_ENV = "DEEPSEEK_API_KEY"
ENV_EXAMPLE = ROOT / "backend" / ".env.example"

# `sk-` plus at least 20 token characters — the shortest real key we have seen
# is 35 chars, so this cannot fire on prose like "disk-level".
KEY_SHAPE = re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}")


def _tracked_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        pytest.skip("not a git checkout — cannot enumerate tracked files")
    return [ROOT / rel for rel in out.stdout.split("\n") if rel.strip()]


def _text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:  # deleted between listing and reading, or a binary blob
        return ""


def test_env_example_names_the_variable_with_an_empty_placeholder():
    """The template tells a developer which variable to set, and holds no value."""
    text = _text(ENV_EXAMPLE)
    assert text, "backend/.env.example is missing"
    assert f"{KEY_ENV}=" in text
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith(f"{KEY_ENV}="):
            assert stripped == f"{KEY_ENV}=", "the placeholder must carry no value"


def test_no_key_shaped_literal_in_tracked_files():
    hits = []
    for path in _tracked_files():
        for match in KEY_SHAPE.finditer(_text(path)):
            # Path + offset only: never the matched text.
            hits.append(f"{path.relative_to(ROOT)}@{match.start()}")
    assert hits == [], f"key-shaped literal(s) in tracked files: {hits}"


def test_exported_key_is_absent_from_every_tracked_file():
    key = os.environ.get(KEY_ENV, "").strip()
    if not key:
        pytest.skip(f"{KEY_ENV} is not exported in this environment")
    hits = [str(p.relative_to(ROOT)) for p in _tracked_files() if key in _text(p)]
    assert hits == [], f"the {KEY_ENV} value appears in tracked files: {hits}"


def test_local_env_files_are_gitignored():
    """The key lives in .env files; those must never be committable."""
    for candidate in (".env", "backend/.env"):
        out = subprocess.run(
            ["git", "check-ignore", "-q", candidate],
            cwd=ROOT, capture_output=True, text=True, check=False,
        )
        assert out.returncode == 0, f"{candidate} is not git-ignored"
