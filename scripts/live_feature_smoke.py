#!/usr/bin/env python3
"""Live feature smoke against a running CourtOps server (default :8000).

Black-box HTTP checks for SPA assets + the UX/D11 fix surface (import tab
class, roster getRows, day-of early_departure + phone, official accept/pay,
dashboard deep-link strings). Creates a short-lived tournament tagged
LiveTest <hex> and leaves it in the DB for inspection.

Usage (server must be running):
  backend/.venv/Scripts/python.exe scripts/live_feature_smoke.py
  backend/.venv/Scripts/python.exe scripts/live_feature_smoke.py http://127.0.0.1:8000

Requires httpx (backend venv). Prefer sequential runs vs e2e/ux_walkthrough —
parallel login storms can trip the process-local throttle.
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import date, timedelta

try:
    import httpx
except ImportError:
    print("need httpx", file=sys.stderr)
    sys.exit(2)

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
# Prefer ADMIN_PASSWORD when the live DB was hardened; fall back to POC default.
ADMIN_USER = os.environ.get("COURTOPS_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD") or os.environ.get("COURTOPS_ADMIN_PASSWORD") or "admin"
c = httpx.Client(base_url=BASE, timeout=30.0, follow_redirects=True)
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
    # 1) SPA shell + changed modules
    for path in [
        "/",
        "/app.js",
        "/styles.css",
        "/app/import_ui.js",
        "/app/roster.js",
        "/app/assignments_ui.js",
        "/app/inbox.js",
        "/app/official_app.js",
        "/app/dayof.js",
        "/app/dashboard.js",
        "/app/staff.js",
        "/app/setup_crud.js",
        "/app/partb.js",
        "/app/pairing_doubles.js",
    ]:
        r = c.get(path)
        check(f"GET {path}", r.status_code == 200 and len(r.content) > 50, f"{len(r.content)} bytes")

    # 2) Fix strings in served JS
    imp = c.get("/app/import_ui.js").text
    check("import fix: needs-active", "import-needs-active" in imp)
    check("import fix: active class", 'toggle("active"' in imp or "toggle('active'" in imp)
    check("import no mangled class", 'toggle("getActive()"' not in imp)
    ros = c.get("/app/roster.js").text
    check("roster fix: getRows active", 'getRows("active")' in ros)
    dayjs = c.get("/app/dayof.js").text
    check("dayof early control", "early_departure" in dayjs and "dayof-early" in dayjs)
    check("dayof phone", "dayof-phone" in dayjs and "tel:" in dayjs)
    dash = c.get("/app/dashboard.js").text
    check("dashboard dayof link", "panel-t-dayof" in dash and "_coverageGo" in dash)
    offjs = c.get("/app/official_app.js").text
    check("official loadMyPay after respond", "loadMyPay" in offjs and "respond" in offjs)
    asgjs = c.get("/app/assignments_ui.js").text
    check("assignments nologin nav", "activateGroup" in asgjs and "panel-officials" in asgjs)
    inboxjs = c.get("/app/inbox.js").text
    check("inbox triage shortcut", 'k === "t"' in inboxjs or "k === 't'" in inboxjs)
    check("inbox unmatched shortcut", 'k === "u"' in inboxjs or "k === 'u'" in inboxjs)
    check("inbox add-to-roster wiring", "rosterAddFromEmail" in inboxjs)
    appjs = c.get("/app.js").text
    for name in (
        "installGlobalSearch",
        "createSetupCrud",
        "createAdminBoot",
        "createOfficialApp",
        "installTrash",
    ):
        check(f"app.js wires {name}", name in appjs)

    # 3) Admin session
    h = c.get("/api/health").json()
    check("health", h.get("status") == "ok" and h.get("db") == "ok", str(h))
    r = c.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD})
    check("admin login", r.status_code == 200, r.text[:120] if r.status_code != 200 else ADMIN_USER)
    if r.status_code != 200:
        print(
            "HINT: set ADMIN_PASSWORD (or COURTOPS_ADMIN_PASSWORD) to the live "
            "admin password if this DB is not the POC default admin/admin",
            file=sys.stderr,
        )
        print("---")
        print(f"SUMMARY: {ok} passed, {fail} failed (stopped at login)")
        return 1
    me = c.get("/api/auth/me").json()
    check("admin me", me.get("role") == "admin")

    # 4) Isolated tournament for feature tests (play starts today → live)
    tag = uuid.uuid4().hex[:6]
    start = date.today()
    end = start + timedelta(days=2)
    tr = c.post(
        "/api/tournaments",
        json={
            "name": f"LiveTest {tag}",
            "type": "junior",
            "play_start_date": str(start),
            "play_end_date": str(end),
            "registration_deadline": str(start - timedelta(days=14)),
            "late_entry_deadline": str(start - timedelta(days=7)),
        },
    )
    check("create tournament", tr.status_code == 201, tr.text[:200])
    t = tr.json()
    tid = t["id"]

    sr = c.post(
        "/api/sites",
        json={"name": f"Live Site {tag}", "code": f"L{tag[:4].upper()}", "city": "Atlanta", "state": "GA"},
    )
    check("create site", sr.status_code == 201, sr.text[:120])
    site = sr.json()
    c.put(f"/api/tournaments/{tid}/sites", json={"site_ids": [site["id"]]})

    or_ = c.post(
        "/api/officials",
        json={
            "first_name": "Live",
            "last_name": f"Off{tag}",
            "email": f"live{tag}@example.com",
            "phone": "555-0100",
        },
    )
    check("create official", or_.status_code == 201, or_.text[:120])
    off = or_.json()
    c.post(f"/api/officials/{off['id']}/certifications", json={"cert_type": "roving_official"})
    acc = c.put(
        f"/api/officials/{off['id']}/account",
        json={"username": f"live{tag}", "password": "livepass1"},
    )
    check("set official login", acc.status_code in (200, 204), acc.text[:120])

    ar = c.post(f"/api/tournaments/{tid}/assignments", json={"official_id": off["id"], "site_id": site["id"]})
    check("create assignment", ar.status_code == 201, ar.text[:160])
    aid = ar.json()["id"]
    dr = c.post(
        f"/api/assignments/{aid}/days",
        json={"work_date": str(start), "working_as": "roving_official"},
    )
    check("add assignment day", dr.status_code == 201, dr.text[:160])

    # Day-of + early_departure
    dof = c.get(f"/api/tournaments/{tid}/day-of", params={"on": str(start)})
    check("day-of GET", dof.status_code == 200, f"officials={dof.json().get('officials_count')}")
    offs = dof.json().get("officials") or []
    check("day-of has official", len(offs) >= 1)
    if offs:
        day_id = offs[0]["day_id"]
        phone = offs[0].get("phone")
        check("day-of phone in payload", phone == "555-0100", str(phone))
        st = c.put(f"/api/assignment-days/{day_id}/status", json={"actual_status": "early_departure"})
        check("early_departure PUT", st.status_code == 200, st.text[:120])
        dof2 = c.get(f"/api/tournaments/{tid}/day-of", params={"on": str(start)}).json()
        stv = next((o["actual_status"] for o in dof2.get("officials", []) if o["day_id"] == day_id), None)
        check("early_departure persisted", stv == "early_departure", str(stv))
        c.put(f"/api/assignment-days/{day_id}/status", json={"actual_status": "planned"})

    dash = c.get(f"/api/tournaments/{tid}/dashboard")
    check("dashboard GET", dash.status_code == 200)
    ready = c.get(f"/api/tournaments/{tid}/readiness")
    check("readiness GET", ready.status_code == 200, str(ready.json().get("summary")))
    nologin = c.get(f"/api/tournaments/{tid}/officials-without-login")
    check("officials-without-login GET", nologin.status_code == 200)

    # Official portal
    c2 = httpx.Client(base_url=BASE, timeout=30.0)
    lr = c2.post("/api/auth/login", json={"username": f"live{tag}", "password": "livepass1"})
    check("official login", lr.status_code == 200, lr.text[:120])
    asgs = c2.get("/api/me/assignments").json()
    check(
        "me/assignments",
        isinstance(asgs, list) and len(asgs) >= 1,
        f"n={len(asgs) if isinstance(asgs, list) else asgs}",
    )
    pay1 = c2.get("/api/me/pay-summary").json()
    check("me/pay-summary", "totals" in pay1)
    if isinstance(asgs, list) and asgs:
        rid = asgs[0]["id"]
        rr = c2.post(f"/api/me/assignments/{rid}/respond", json={"status": "accepted"})
        check("official accept", rr.status_code == 200, rr.text[:120])
        asgs2 = c2.get("/api/me/assignments").json()
        st = next((a["response_status"] for a in asgs2 if a["id"] == rid), None)
        check("response accepted", st == "accepted", str(st))
        pay2 = c2.get("/api/me/pay-summary").json()
        check("pay-summary after accept", "totals" in pay2)
        c2.post(f"/api/me/assignments/{rid}/respond", json={"status": "pending"})

    types = c.get("/api/import/types")
    check("import types", types.status_code == 200 and len(types.json()) >= 5, f"n={len(types.json())}")
    tmpl = c.get("/api/import/template/roster", params={"fmt": "csv"})
    check("import roster template", tmpl.status_code == 200 and b"usta" in tmpl.content.lower())

    check("emails list", c.get("/api/emails", params={"tournament_id": tid, "limit": 5}).status_code == 200)
    check("roster list", c.get(f"/api/tournaments/{tid}/players").status_code == 200)
    check("staff list", c.get(f"/api/tournaments/{tid}/staff").status_code == 200)
    check("incidents list", c.get(f"/api/tournaments/{tid}/incidents").status_code == 200)
    check("assignments list", c.get(f"/api/tournaments/{tid}/assignments").status_code == 200)

    idx = c.get("/").text
    check("index loads module app.js", "app.js" in idx and 'type="module"' in idx)

    print("---")
    print(f"SUMMARY: {ok} passed, {fail} failed")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
