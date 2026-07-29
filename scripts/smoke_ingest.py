#!/usr/bin/env python3
"""Smoke-test the email auto-ingest webhook (D4).

Checks:
  1. GET /api/ingest/status  → enabled
  2. POST with wrong token   → 401
  3. POST JSON (late entry)  → 201 / 200
  4. POST same message_id    → 200 duplicate
  5. Optional form endpoint

Usage:
  set INGEST_TOKEN=…          # required
  # optional:
  set INGEST_TO=macon2026@inbox.example.com
  set INGEST_DEFAULT_EXPECT=2   # expected tournament_id (or omit)

  backend/.venv/Scripts/python.exe scripts/smoke_ingest.py
  backend/.venv/Scripts/python.exe scripts/smoke_ingest.py https://courtops-poc.fly.dev

Does not need admin login — token auth only.
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone

try:
    import httpx
except ImportError:
    print("need httpx (use backend/.venv)", file=sys.stderr)
    sys.exit(2)

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
TOKEN = (os.environ.get("INGEST_TOKEN") or "").strip()
TO_ADDR = (os.environ.get("INGEST_TO") or "macon2026@inbox.courtops-poc.fly.dev").strip()
EXPECT_TID = os.environ.get("INGEST_DEFAULT_EXPECT", "").strip()  # e.g. "2"

ok = fail = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global ok, fail
    if cond:
        ok += 1
        print(f"PASS  {name}" + (f" — {detail}" if detail else ""))
    else:
        fail += 1
        print(f"FAIL  {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    if not TOKEN:
        print("set INGEST_TOKEN in the environment (Fly secret value)", file=sys.stderr)
        return 2

    c = httpx.Client(base_url=BASE, timeout=30.0, follow_redirects=True)
    print(f"BASE={BASE}")

    # 1) status
    r = c.get("/api/ingest/status")
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    check("GET /api/ingest/status", r.status_code == 200, str(body)[:120])
    check("ingest enabled", body.get("enabled") is True, str(body.get("enabled")))

    # 2) wrong token
    mid = f"<smoke-{uuid.uuid4().hex}@courtops.test>"
    payload = {
        "message_id": mid,
        "from_address": "parent@example.com",
        "to_address": TO_ADDR,
        "subject": "Late entry smoke",
        "body": "Can we still register late for the junior event?",
        "received_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    bad = c.post(
        "/api/ingest/email",
        headers={"X-Ingest-Token": "not-the-real-token", "Content-Type": "application/json"},
        json=payload,
    )
    check("wrong token → 401", bad.status_code == 401, f"{bad.status_code} {bad.text[:80]}")

    # 3) good JSON
    good = c.post(
        "/api/ingest/email",
        headers={"X-Ingest-Token": TOKEN, "Content-Type": "application/json"},
        json=payload,
    )
    check(
        "POST /api/ingest/email → 201/200",
        good.status_code in (200, 201),
        f"{good.status_code} {good.text[:160]}",
    )
    data = {}
    try:
        data = good.json()
    except Exception:
        pass
    if good.status_code in (200, 201) and data:
        check("response has id", "id" in data, str(data.get("id")))
        check("status new", data.get("status") == "new", str(data.get("status")))
        if EXPECT_TID:
            check(
                f"tournament_id == {EXPECT_TID}",
                str(data.get("tournament_id")) == EXPECT_TID,
                str(data.get("tournament_id")),
            )
        else:
            print(f"INFO  tournament_id={data.get('tournament_id')} classification={data.get('classification')}")

    # 4) duplicate
    dup = c.post(
        "/api/ingest/email",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        json=payload,
    )
    check("duplicate message_id → 200", dup.status_code == 200, f"{dup.status_code} {dup.text[:120]}")
    try:
        d2 = dup.json()
        check("duplicate flag", d2.get("duplicate") is True, str(d2.get("duplicate")))
    except Exception:
        check("duplicate JSON", False, dup.text[:80])

    # 5) form endpoint (Mailgun/SendGrid shape)
    mid2 = f"<form-{uuid.uuid4().hex}@courtops.test>"
    form = c.post(
        "/api/ingest/email/form",
        headers={"X-Ingest-Token": TOKEN},
        data={
            "from": "coach@example.com",
            "to": TO_ADDR,
            "subject": "Withdrawal request smoke",
            "body-plain": "Please withdraw my child from the event.",
            "Message-Id": mid2,
        },
    )
    check(
        "POST /api/ingest/email/form → 201/200",
        form.status_code in (200, 201),
        f"{form.status_code} {form.text[:160]}",
    )

    print(f"\nSUMMARY: {ok} passed, {fail} failed")
    print("Open Inbox for the routed tournament and triage (t / d / f).")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
