#!/usr/bin/env python3
"""Smoke the configured small-LLM endpoint the same way CourtOps does.

Probes the provider's health URL, then drives the shipped
``app.email_llm.extract_email`` against ``/chat/completions`` with the
provider's own credential.

Providers (``EMAIL_LLM_PROVIDER``):
  deepseek (default) - the DeepSeek API. Needs DEEPSEEK_API_KEY in the
    environment; sends the leftover email text off this machine.
  local - the llama.cpp sidecar (127.0.0.1:8080 locally, or
    courtops-llm.internal from a Fly Machine) with EMAIL_LLM_TOKEN.

Usage (PowerShell):
  # DeepSeek (default)
  $env:EMAIL_LLM=1
  $env:DEEPSEEK_API_KEY='...'
  backend/.venv/Scripts/python.exe scripts/smoke_email_llm.py

  # Local sidecar
  docker compose -f docker-compose.llm.yml up --build
  $env:EMAIL_LLM=1
  $env:EMAIL_LLM_PROVIDER='local'
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
os.environ.setdefault("EMAIL_LLM_TIMEOUT", "60")

from app.email_llm import (  # noqa: E402
    extract_email,
    llm_api_key,
    llm_base_url,
    llm_health_url,
    llm_model,
    llm_provider,
    probe_llm,
)


def main() -> int:
    base = llm_base_url()
    health = llm_health_url()
    print("provider", llm_provider())
    print("base", base)
    print("model", llm_model())
    print("health_url", health)
    print("key_present", bool(llm_api_key()))          # never the value itself
    status = probe_llm(timeout=15)
    print("probe", status)
    if status != "ok":
        # Show the raw HTTP error so a missing key / wrong URL is obvious.
        req = urllib.request.Request(health)
        token = llm_api_key()
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            urllib.request.urlopen(req, timeout=15).read()
        except urllib.error.HTTPError as e:
            print("health HTTP", e.code, e.reason, file=sys.stderr)
        except Exception as e:
            print("health error", type(e).__name__, e, file=sys.stderr)
        print("FAIL: endpoint not reachable — check EMAIL_LLM_PROVIDER / key",
              file=sys.stderr)
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
