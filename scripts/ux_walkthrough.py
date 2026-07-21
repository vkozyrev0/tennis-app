"""Black-box UX walkthrough against a live server (admin + official).

Usage (server must be running):
  backend/.venv/Scripts/python.exe scripts/ux_walkthrough.py
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

try:
    import httpx
except ImportError:
    print("need httpx", file=sys.stderr)
    sys.exit(2)

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
ADMIN_USER = os.environ.get("COURTOPS_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD") or os.environ.get("COURTOPS_ADMIN_PASSWORD") or "admin"
findings: list[tuple[bool, str, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    findings.append((bool(cond), name, detail))
    mark = "OK  " if cond else "FAIL"
    extra = f" — {detail}" if detail and not cond else ""
    print(f"{mark} | {name}{extra}")


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=30.0)

    h = c.get("/api/health").json()
    check("health db ok", h.get("db") == "ok", str(h))

    r = c.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD})
    check("admin login", r.status_code == 200, r.text[:200])
    if r.status_code != 200:
        print(
            "HINT: set ADMIN_PASSWORD if the live DB is not admin/admin",
            file=sys.stderr,
        )

    for path in (
        "/api/tournaments",
        "/api/sites",
        "/api/officials",
        "/api/players",
        "/api/rates",
        "/api/hotels",
        "/api/divisions",
        "/api/trash",
    ):
        rr = c.get(path)
        check(f"admin GET {path}", rr.status_code == 200, str(rr.status_code))

    ts = c.get("/api/tournaments").json()
    t = next((x for x in ts if not x.get("deleted_at")), ts[0] if ts else None)
    check("have tournament", t is not None)
    if not t:
        return _summary()
    tid = t["id"]
    print(f"    using tournament {tid}: {t.get('name')}")

    workspace = [
        f"/api/tournaments/{tid}/players",
        f"/api/tournaments/{tid}/assignments",
        f"/api/tournaments/{tid}/sites",
        f"/api/tournaments/{tid}/availability",
        f"/api/emails?tournament_id={tid}&limit=50",
        f"/api/emails/status-counts?tournament_id={tid}",
        f"/api/tournaments/{tid}/reports/officials",
        f"/api/tournaments/{tid}/payroll",
        f"/api/tournaments/{tid}/readiness",
        f"/api/tournaments/{tid}/incidents",
        f"/api/tournaments/{tid}/staff",
        f"/api/tournaments/{tid}/late-entries",
        f"/api/tournaments/{tid}/withdrawals",
        f"/api/tournaments/{tid}/doubles",
        f"/api/tournaments/{tid}/pairing-avoidances",
    ]
    # Day-of / dashboard naming varies — probe several.
    probes = [
        f"/api/tournaments/{tid}/day-of",
        f"/api/tournaments/{tid}/dayof",
        f"/api/dashboard?tournament_id={tid}",
        f"/api/tournaments/{tid}/dashboard",
        f"/api/dashboard/{tid}",
    ]
    for path in workspace:
        rr = c.get(path)
        check(f"workspace GET …{path.split(str(tid))[-1][:40]}", rr.status_code == 200,
              f"{rr.status_code} {rr.text[:100]}")

    day_ok = False
    for path in probes:
        rr = c.get(path)
        if rr.status_code == 200:
            day_ok = True
            print(f"    day/dashboard OK: {path}")
            break
        print(f"    probe {path} → {rr.status_code}")
    check("day-of or dashboard endpoint exists", day_ok)

    rr = c.get(f"/api/emails?tournament_id={tid}&limit=20")
    check("emails list", rr.status_code == 200)
    check("emails X-Total-Count header", rr.headers.get("X-Total-Count") is not None,
          str(rr.headers.get("X-Total-Count")))
    if rr.status_code == 200 and rr.json():
        em = rr.json()[0]
        check("email row has detected_division key", "detected_division" in em)

    # Official portal: reuse existing demo login if any, else create one.
    off = httpx.Client(base_url=BASE, timeout=30.0)
    logged = False
    for user, pw in (("official", "official"), ("demo", "demo")):
        lr = off.post("/api/auth/login", json={"username": user, "password": pw})
        if lr.status_code == 200 and lr.json().get("role") == "official":
            print(f"    official login: {user}")
            logged = True
            break
    if not logged:
        o = c.post("/api/officials", json={
            "first_name": "Walk", "last_name": "Through",
            "email": f"walk+{uuid.uuid4().hex[:6]}@example.com",
        })
        check("create walkthrough official", o.status_code == 201, o.text[:120])
        oid = o.json()["id"]
        uname = "walk_" + uuid.uuid4().hex[:6]
        acc = c.put(f"/api/officials/{oid}/account",
                    json={"username": uname, "password": "walkwalk1"})
        check("set official login", acc.status_code in (200, 201), acc.text[:120])
        # attach cert so they can be assigned
        c.post(f"/api/officials/{oid}/certifications",
               json={"cert_type": "roving_official"})
        lr = off.post("/api/auth/login", json={"username": uname, "password": "walkwalk1"})
        check("new official login", lr.status_code == 200, lr.text[:120])
        logged = lr.status_code == 200
        # assign to tournament if possible
        if logged:
            ar = c.post(f"/api/tournaments/{tid}/assignments",
                        json={"official_id": oid})
            check("assign walkthrough official", ar.status_code in (201, 409), ar.text[:120])

    if logged:
        for path in (
            "/api/me",
            "/api/me/assignments",
            "/api/me/tournaments",
            "/api/me/pay-summary",
        ):
            rr = off.get(path)
            check(f"official GET {path}", rr.status_code == 200, f"{rr.status_code}")
        ics = off.get("/api/me/schedule.ics")
        check("official schedule.ics", ics.status_code == 200, f"{ics.status_code}")
        # Official must not hit admin routes
        deny = off.get("/api/players")
        check("official blocked from /api/players", deny.status_code in (401, 403),
              str(deny.status_code))
        # respond if any pending assignment
        asgs = off.get("/api/me/assignments").json()
        pending = [a for a in asgs if a.get("response_status") == "pending"]
        if pending:
            aid = pending[0]["id"]
            rr = off.post(f"/api/me/assignments/{aid}/respond",
                          json={"status": "accepted"})
            check("official accept assignment", rr.status_code == 200, rr.text[:120])
        else:
            print("    (no pending assignment to accept)")

    # Frontend assets
    for path in ("/", "/app.js", "/index.html", "/styles.css"):
        rr = c.get(path)
        check(f"static {path}", rr.status_code == 200, str(rr.status_code))

    return _summary()


def _summary() -> int:
    fails = [f for f in findings if not f[0]]
    ok = len(findings) - len(fails)
    print("---")
    print(f"{ok}/{len(findings)} checks passed, {len(fails)} failed")
    for _, name, detail in fails:
        print(f"  FAIL: {name} — {detail}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
