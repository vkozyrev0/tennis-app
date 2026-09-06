#!/usr/bin/env python3
"""Run the three representative TD-chat tasks against the live 1.5B sidecar.

Does not apply writes. Prints a pass/fail table. Exit 0 even if 1.5B fails
the tasks — the verdict is the result, not a test failure.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ.setdefault("EMAIL_LLM", "1")
os.environ.setdefault("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
os.environ.setdefault("EMAIL_LLM_TOKEN", "dev-local-llm")
os.environ.setdefault("EMAIL_LLM_CHAT_TIMEOUT", "60")

from app.email_llm import probe_llm  # noqa: E402
from app.main import app  # noqa: E402
from app.td_chat import (  # noqa: E402
    ALLOWED_TOOLS,
    build_catalog,
    chat_complete,
    parse_plan,
    planner_prompt,
    resolve_tool,
)

TASKS = [
    ("status", "What is the status of this tournament?", ["tournament_status"]),
    ("add_player", "Add player Jane Roe, USTA 123456789, female, G16 to the roster.", ["add_player"]),
    ("remove_player", "Remove roster entry 42 from the tournament.", ["remove_player"]),
]


def score(task_key, want_tools, plan) -> tuple[bool, str]:
    names = [c["tool"] for c in plan.get("calls") or []]
    if not names:
        return False, "no calls parsed"
    unknown = [n for n in names if n not in ALLOWED_TOOLS]
    if unknown:
        return False, "unknown tools: " + ",".join(unknown)
    if not any(t in names for t in want_tools):
        return False, f"wanted {want_tools}, got {names}"
    try:
        for c in plan["calls"]:
            resolve_tool(c["tool"], c.get("args") or {}, tournament_id=1)
    except Exception as e:
        return False, f"resolve failed: {e}"
    return True, "ok " + str(names)


def main() -> int:
    sidecar = probe_llm(timeout=5)
    print("sidecar", sidecar)
    if sidecar != "ok":
        print("VERDICT unverifiable — GET sidecar /health is not ok")
        print("blocking: unverifiable")
        return 2
    cat = build_catalog(app)
    rows = []
    for key, message, want in TASKS:
        prompt = planner_prompt(message, cat, tournament_id=1)
        try:
            raw = chat_complete(prompt)
        except Exception as e:
            raw = f"ERROR {type(e).__name__}: {e}"
            plan = {"calls": [], "say": ""}
            ok, note = False, raw
        else:
            plan = parse_plan(raw)
            ok, note = score(key, want, plan)
        rows.append({
            "task": key,
            "pass": ok,
            "note": note,
            "raw": (raw or "")[:1500],
            "calls": plan.get("calls"),
        })
        print(f"{key}: {'PASS' if ok else 'FAIL'} {note}")
        print(" raw:", (raw or "")[:400].replace("\n", " "))
    n_ok = sum(1 for r in rows if r["pass"])
    sufficient = n_ok == len(TASKS)
    verdict = "sufficient" if sufficient else "insufficient"
    print("VERDICT", verdict, f"{n_ok}/{len(TASKS)}")
    print(json.dumps({"verdict": verdict, "passed": n_ok, "total": len(TASKS), "rows": rows}, indent=2))
    return 0 if sidecar == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
