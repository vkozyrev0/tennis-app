#!/usr/bin/env python3
"""Smoke the llama.cpp sidecar the same way CourtOps does on Fly.

Hits GET /health then drives the shipped ``app.email_llm.extract_email``
against /v1/chat/completions (Bearer EMAIL_LLM_TOKEN). Works locally
(127.0.0.1:8080) or, from a Fly Machine, against courtops-llm.internal.

Usage (PowerShell):
  docker compose -f docker-compose.llm.yml up --build
  $env:EMAIL_LLM=1
  $env:EMAIL_LLM_BASE_URL='http://127.0.0.1:8080/v1'
  $env:EMAIL_LLM_TOKEN='dev-local-llm'
  $env:EMAIL_LLM_TIMEOUT='60'
  backend/.venv/Scripts/python.exe scripts/smoke_email_llm.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# Allow `python scripts/smoke_email_llm.py` from the repo root.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

os.environ.setdefault("EMAIL_LLM", "1")
os.environ.setdefault("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
os.environ.setdefault("EMAIL_LLM_TOKEN", "dev-local-llm")
os.environ.setdefault("EMAIL_LLM_TIMEOUT", "60")

from app.email_llm import (  # noqa: E402
    extract_email,
    llm_base_url,
    llm_health_url,
    probe_llm,
)


def main() -> int:
    base = llm_base_url()
    health = llm_health_url()
    print("base", base)
    print("health_url", health)
    status = probe_llm(timeout=5)
    print("probe", status)
    if status != "ok":
        # Show the raw HTTP error so a missing GGUF / wrong token is obvious.
        try:
            urllib.request.urlopen(health, timeout=5).read()
        except urllib.error.HTTPError as e:
            print("health HTTP", e.code, e.reason, file=sys.stderr)
        except Exception as e:
            print("health error", type(e).__name__, e, file=sys.stderr)
        print("FAIL: sidecar not reachable — start docker-compose.llm.yml", file=sys.stderr)
        return 1
    parsed = extract_email(
        "Re: L3 Doubles",
        "Please pair Kai Hosch and Gabriel Zingman for doubles.",
    )
    print("extract", json.dumps(parsed, default=str))
    if not parsed or parsed.get("intent") not in {
        "doubles", "withdrawal", "late_entry", "other",
        "pairing_avoidance", "scheduling_avoidance", "division_flex", "hotel",
    }:
        print("FAIL: extract_email returned nothing usable", file=sys.stderr)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
