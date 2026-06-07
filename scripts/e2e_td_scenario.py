#!/usr/bin/env python3
"""Full-scale end-to-end Tournament-Director scenario driver (standalone).

Runs against a LIVE CourtOps server (default http://localhost:8000) as an
external HTTP client — it does NOT import the app, so it can point at any
running instance. It logs in as admin, generates a realistic tournament's worth
of test data, and simulates a TD's end-to-end workflow *and the challenges they
hit*: incomplete roster, unfiled email triage, coverage gaps, cross-tournament
double-bookings, uncertified days, declined assignments, withdrawals + alternate
promotion, missing mileage distances, officials with no login, lodging/dietary.

It exercises (nearly) every API surface and checks each challenge SURFACES where
the TD would look (readiness scorecard, conflict report, dashboards, exports).
Every unexpected result is recorded as a DISCOVERY and printed at the end; with
--write-findings it also appends a dated section to docs/e2e-findings.md.

Usage:
    python scripts/e2e_td_scenario.py [--base-url URL] [--write-findings]

Requires only the Python standard library. The target server must be running
(e.g. the dev/preview server on :8000). Data is tagged with a per-run id so the
rows it creates are identifiable; it does not delete them (safe for a dev DB).
"""
from __future__ import annotations

import argparse
import http.cookiejar
import io
import json
import sys
import urllib.error
import urllib.request
import uuid
from datetime import date, timedelta

# Windows consoles default to cp1252, which can't encode the ✓/✗/⚑ glyphs;
# force UTF-8 (replace as a last resort) so the report renders anywhere.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

import random

RUN = uuid.uuid4().hex[:6]          # internal run id (logins/USTA base; not shown in names)
TODAY = date.today()
PLAY_START = TODAY + timedelta(days=14)
PLAY_END = TODAY + timedelta(days=16)   # a 3-day event
DAYS = [(PLAY_START + timedelta(days=i)).isoformat() for i in range(3)]

# ── realistic data pools (so the generated tournament reads like a real one) ──
_rng = random.Random()
_PLACES = ["Riverside", "Oakwood", "Lakeshore", "Summit", "Brookfield", "Fairview",
           "Highland", "Westgate", "Cedar Ridge", "Hillcrest", "Maplewood", "Stonebridge",
           "Glenwood", "Ashford", "Bayside", "Northgate"]
_HOTELS = ["Courtyard by Marriott", "Hampton Inn", "Hilton Garden Inn", "Holiday Inn",
           "Hyatt Place", "Residence Inn"]
# Officials have no gender field, so a mixed adult pool is fine. The players in
# this scenario are all entered in a girls' (G16) division, so they draw from a
# female-name pool — otherwise you'd get "Liam … female" mismatches.
_ADULT_FIRST = ["Sarah", "Michael", "Jennifer", "David", "Emily", "James", "Maria",
                "Robert", "Linda", "Carlos", "Aisha", "Daniel", "Grace", "Thomas",
                "Nina", "Andre", "Olivia", "Marcus", "Priya", "Kevin"]
_GIRL_FIRST = ["Ava", "Mia", "Zoe", "Ella", "Maya", "Chloe", "Lily", "Nora", "Sofia",
               "Olivia", "Grace", "Hannah", "Layla", "Aria", "Ruby", "Ivy"]
_LAST = ["Chen", "Torres", "Patel", "Johnson", "Nguyen", "Rodriguez", "Kim", "Williams",
         "Garcia", "Murphy", "Okafor", "Schmidt", "Rossi", "Larsen", "Brooks", "Hayes",
         "Flores", "Bauer", "Singh", "Walsh", "Petrov", "Tanaka", "Cohen", "Mbeki"]


def _sampler(pool):
    """Endless source of distinct items from a shuffled copy of the pool."""
    items = pool[:]
    _rng.shuffle(items)
    return iter(items)


_adult = _sampler(_ADULT_FIRST)
_girl = _sampler(_GIRL_FIRST)
_surname = _sampler(_LAST)


# Prefer httpx (robust HTTP/1.1 + cookie handling) when available — plain urllib
# POSTs reset intermittently against uvicorn on Windows. urllib stays as a
# stdlib-only fallback so the script runs anywhere.
try:
    import httpx  # type: ignore
except ImportError:
    httpx = None


# ───────────────────────────── HTTP client ──────────────────────────────────
class _HttpxClient:
    """Cookie-aware JSON/multipart client backed by httpx (one session each)."""

    def __init__(self, base: str):
        self._c = httpx.Client(base_url=base.rstrip("/"), timeout=60.0)

    @staticmethod
    def _body(r):
        try:
            return r.json()
        except Exception:
            return r.text

    def request(self, method, path, body=None):
        r = self._c.request(method, path, json=body)
        return r.status_code, self._body(r)

    def get(self, p):
        return self.request("GET", p)

    def post(self, p, b=None):
        return self.request("POST", p, b if b is not None else {})

    def put(self, p, b=None):
        return self.request("PUT", p, b if b is not None else {})

    def upload(self, path, field, filename, content, content_type="text/csv"):
        r = self._c.post(path, files={field: (filename, content.encode(), content_type)})
        return r.status_code, self._body(r)


class _UrllibClient:
    """Cookie-aware JSON/multipart HTTP client over urllib (stdlib fallback)."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def _send(self, req):
        # Force a fresh connection per request — Windows + urllib keep-alive reuse
        # against uvicorn intermittently raises ConnectionReset. We retry, but ONLY
        # for idempotent GETs: retrying a POST/PUT that the server already committed
        # (the reset can land after the write) would duplicate it. Non-GET resets
        # are surfaced instead.
        req.add_header("Connection", "close")
        idempotent = req.get_method() == "GET"
        attempts = 4 if idempotent else 1
        last = None
        for _ in range(attempts):
            try:
                with self.opener.open(req, timeout=60) as resp:
                    raw = resp.read().decode()
                    return resp.status, (json.loads(raw) if raw else None)
            except urllib.error.HTTPError as e:
                raw = e.read().decode()
                try:
                    payload = json.loads(raw)
                except ValueError:
                    payload = raw
                return e.code, payload
            except (ConnectionResetError, urllib.error.URLError, OSError) as e:
                last = e
                continue
        raise SystemExit(
            f"\n✗ {req.get_method()} {req.full_url} failed: {last}. "
            f"(Non-GET requests are not retried to avoid duplicate writes.)")

    def request(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        return self._send(req)

    def get(self, p):
        return self.request("GET", p)

    def post(self, p, b=None):
        return self.request("POST", p, b if b is not None else {})

    def put(self, p, b=None):
        return self.request("PUT", p, b if b is not None else {})

    def upload(self, path, field, filename, content, content_type="text/csv"):
        boundary = "----e2e" + uuid.uuid4().hex
        buf = io.BytesIO()
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{field}"; '
                  f'filename="{filename}"\r\n'.encode())
        buf.write(f"Content-Type: {content_type}\r\n\r\n".encode())
        buf.write(content.encode() + b"\r\n")
        buf.write(f"--{boundary}--\r\n".encode())
        req = urllib.request.Request(self.base + path, data=buf.getvalue(), method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        return self._send(req)


def Client(base: str):
    """Pick the most robust available transport."""
    return _HttpxClient(base) if httpx is not None else _UrllibClient(base)


# ───────────────────────────── reporting ────────────────────────────────────
DISCOVERIES: list[str] = []
_checks = {"pass": 0, "fail": 0}


def phase(title: str):
    print(f"\n\033[1m=== {title} ===\033[0m")


def step(msg: str):
    print(f"  · {msg}")


def discover(msg: str):
    DISCOVERIES.append(msg)
    print(f"  \033[33m⚑ DISCOVERY:\033[0m {msg}")


def check(label: str, ok: bool, detail: str = ""):
    if ok:
        _checks["pass"] += 1
        print(f"  \033[32m✓\033[0m {label}")
    else:
        _checks["fail"] += 1
        print(f"  \033[31m✗ {label}\033[0m — {detail}")
        DISCOVERIES.append(f"{label}: {detail}")
    return ok


def ok(status, label, want=(200, 201)) -> bool:
    want = want if isinstance(want, tuple) else (want,)
    good = status in want
    if not good:
        discover(f"{label} returned HTTP {status} (wanted {want})")
    return good


# ───────────────────────────── scenario ─────────────────────────────────────
def run(base_url: str):
    c = Client(base_url)
    print(f"CourtOps E2E scenario · run={RUN} · target={base_url} · play {DAYS[0]}…{DAYS[-1]}")

    # ---- P0: connect + admin login -----------------------------------------
    phase("P0 — Connect & authenticate")
    s, _ = c.get("/api/health")
    check("server health reachable", s == 200, f"HTTP {s}")
    s, body = c.post("/api/auth/login", {"username": "admin", "password": "admin"})
    if not check("admin login", s == 200, f"HTTP {s}: {body}"):
        raise SystemExit("Cannot continue without an admin session.")

    # ---- P1: setup catalog (sites, hotel, room block) -----------------------
    phase("P1 — Setup: sites, hotel, official room block")
    sa_place, sb_place = _rng.sample(_PLACES, 2)
    s, sa = c.post("/api/sites", {"name": f"{sa_place} Tennis Center"})
    ok(s, "create site (Tennis Center)", 201)
    s, sb = c.post("/api/sites", {"name": f"{sb_place} Racquet Club"})
    ok(s, "create site (Racquet Club)", 201)
    site_ids = {"A": sa["id"], "B": sb["id"]}
    s, hotel = c.post("/api/hotels", {"name": f"{_rng.choice(_HOTELS)} {_rng.choice(_PLACES)}"})
    ok(s, "create hotel", 201)

    def new_tournament(type_, kinds):
        """Create a tournament with a realistic, unique name (retry on name clash)."""
        body = {"type": type_, "play_start_date": PLAY_START.isoformat(),
                "play_end_date": PLAY_END.isoformat()}
        if type_ == "junior":
            body["registration_deadline"] = (TODAY + timedelta(days=7)).isoformat()
            body["late_entry_deadline"] = (TODAY + timedelta(days=10)).isoformat()
        for _ in range(12):
            name = f"{_rng.choice(_PLACES)} {_rng.choice(kinds)}"
            st, t = c.post("/api/tournaments", {**body, "name": name})
            if st == 201:
                return t
            if st != 409:
                ok(st, "create tournament", 201)
                return None
        discover("could not find a unique tournament name after 12 tries")
        return None

    tourn = new_tournament("junior", ["Junior Open", "Junior Championships",
                                      "Junior Classic", "Junior Invitational"])
    if not tourn:
        raise SystemExit("Cannot continue without a tournament.")
    tid = tourn["id"]
    step(f"tournament: “{tourn['name']}” (id={tid})")

    s, _ = c.put(f"/api/tournaments/{tid}/sites", {"site_ids": list(site_ids.values())})
    ok(s, "link sites to tournament", 200)

    confirmation = "".join(_rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(7))
    s, block = c.post("/api/room-blocks", {
        "hotel_id": hotel["id"], "tournament_id": tid, "kind": "official", "room_count": 5,
        "confirmation_number": confirmation, "check_in": DAYS[0], "check_out": DAYS[-1]})
    ok(s, "create official room block", 201)
    block_id = block["id"]

    # second tournament (same dates) — to manufacture a cross-tournament clash
    t2 = new_tournament("adult", ["Adult Open", "Adult Championships",
                                  "Adult Masters", "Senior Open"])
    t2id = t2["id"] if t2 else None

    # ---- P2: officials, certs, logins, availability -------------------------
    phase("P2 — Officials: certifications, logins, availability")
    officials = {}

    def make_official(key, certs, login=False, avail=None, dietary=None):
        first, last = next(_adult), next(_surname)
        body = {"first_name": first, "last_name": last,
                "email": f"{first.lower()}.{last.lower()}@example.com"}
        if dietary:
            body["dietary_restrictions"] = dietary
        s, o = c.post("/api/officials", body)
        ok(s, f"create official {first} {last}", 201)
        oid = o["id"]
        for ct in certs:
            s, _ = c.post(f"/api/officials/{oid}/certifications", {"cert_type": ct})
            ok(s, f"  cert {ct} → {first} {last}", 201)
        creds = None
        if login:
            uname = f"{first[0].lower()}{last.lower()}{RUN[:4]}"   # realistic + unique
            s, _ = c.put(f"/api/officials/{oid}/account", {"username": uname, "password": "pw"})
            ok(s, f"  login for {first} {last}", 200)
            creds = (uname, "pw")
        if avail:
            s, _ = c.put(f"/api/tournaments/{tid}/availability",
                         {"official_id": oid, "dates": avail, "hotel_needed": bool(dietary)})
            ok(s, f"  availability for {first} {last}", 200)
        officials[key] = {"id": oid, "creds": creds, "name": f"{last}, {first}",
                          "first": first, "last": last}
        return oid

    # internal keys describe the ROLE each plays in the scenario; names are realistic.
    make_official("chair", ["chair_umpire"], login=True, avail=DAYS)
    make_official("rover", ["roving_official"], login=True, avail=DAYS[:2])
    make_official("nologin", ["chair_umpire"], login=False)            # assigned, can't respond
    make_official("noavail", ["roving_official"], login=True)          # never declared availability
    make_official("nocert", [], login=True)                           # holds no certifications
    make_official("veg", ["chair_umpire"], login=True, avail=DAYS, dietary="Vegetarian")

    # ---- P3: roster import (CSV) + alternate --------------------------------
    phase("P3 — Roster: CSV import (complete + incomplete rows) + an alternate")
    # 10-digit USTA #s, unique per run AND per player (the differentiating digits
    # must survive — an earlier truncation bug collided them onto one player).
    ubase = str(int(RUN, 16) % 10**6).zfill(6)   # 6 stable digits for this run
    def usta(n):
        return ubase + str(n).zfill(4)            # 10 digits, unique per n
    p_complete, p_incomplete, p_withdraw, p_alt = usta(1), usta(2), usta(3), usta(4)

    def girl():
        return next(_girl), next(_surname)
    pc = girl(); pi = girl(); pw = girl(); pa = girl()   # (first, last) per girls'-division player
    csv = (
        "usta_number,first_name,last_name,gender,age_division,t_shirt_size,selection_status\n"
        f"{p_complete},{pc[0]},{pc[1]},female,G16,YM,selected\n"
        f"{p_incomplete},{pi[0]},{pi[1]},female,,,selected\n"            # missing div + shirt
        f"{p_withdraw},{pw[0]},{pw[1]},female,G16,AS,selected\n"
    )
    s, batch = c.upload(f"/api/import/tournaments/{tid}/roster", "file", "roster.csv", csv)
    if ok(s, "stage roster CSV", 201):
        check("CSV staged 3 rows", batch.get("total") == 3, f"got {batch.get('total')}")
        s, merged = c.post(f"/api/import/batches/{batch['batch_id']}/merge")
        ok(s, "merge roster batch", 200)
        check("3 roster rows merged", merged.get("merged") == 3, f"got {merged.get('merged')}")
    # add an alternate in the same division so withdrawal→promote has a candidate
    s, _ = c.post(f"/api/tournaments/{tid}/players", {
        "usta_number": p_alt, "first_name": pa[0], "last_name": pa[1],
        "gender": "female", "age_division": "G16", "selection_status": "alternate"})
    ok(s, f"add an alternate: {pa[0]} {pa[1]} (G16)", 201)

    s, comp = c.get(f"/api/tournaments/{tid}/roster-completeness")
    if ok(s, "roster completeness check", 200):
        check("incomplete roster entry flagged", comp["counts"]["incomplete_entries"] >= 1,
              f"got {comp['counts']['incomplete_entries']}")

    # ---- P4: Part B inbound emails + one-click triage -----------------------
    phase("P4 — Inbox: inbound emails → one-click triage")
    def parent_email(p):
        return f"{p[0].lower()}.{p[1].lower()}.parent@gmail.com"
    emails = [
        (f"Withdrawal — {pw[0]} {pw[1]}", parent_email(pw),
         f"Hi, {pw[0]} {pw[1]} (USTA {p_withdraw}) has to withdraw — a wrist injury. Sorry for the late notice."),
        ("Late entry request", parent_email(pc),
         f"Is it too late to enter {pc[0]} {pc[1]}, USTA {p_complete}? We just missed the deadline."),
        (f"Doubles partner for {pc[0]}?", parent_email(pc),
         f"{pc[0]} {pc[1]} (USTA {p_complete}) is hoping to find a doubles partner for the event."),
        ("Hotel for officials?", "frontdesk@hotels.example.com",
         "Which hotel are the officials staying at, and is there a room block rate?"),
        ("Schedule question", "info@localtennis.example.com",
         "What time do gates open on finals day?"),   # unmatched, unclassifiable
    ]
    email_ids = []
    for subj, sender, bodytext in emails:
        s, em = c.post("/api/emails", {"tournament_id": tid, "from_address": sender,
                                       "subject": subj, "body": bodytext})
        ok(s, f"inbound email: {subj}", 201)
        email_ids.append(em["id"])
    s, triage = c.post("/api/emails/bulk/triage", {"email_ids": email_ids})
    if ok(s, "bulk triage (classify→detect→populate)", 200):
        step(f"classified {triage['classified']}, matched {triage['detected']}, "
             f"filed {triage['filed']}, skipped {len(triage['skipped'])}")
        check("triage filed at least the withdrawal+late-entry", triage["filed"] >= 1,
              f"filed {triage['filed']}")
    s, counts = c.get(f"/api/emails/status-counts?tournament_id={tid}")
    if ok(s, "inbox status counts", 200):
        step(f"inbox: {counts['new']} new, {counts['filed']} filed, "
             f"{counts['unmatched']} unmatched")

    # ---- P5: assignments + deliberately manufactured challenges -------------
    phase("P5 — Assignments + manufactured challenges")
    def nm(key):
        return officials[key]["first"]

    # bulk-invite chair + rover + dietary-chair + the no-login + the no-cert official
    invite_ids = [officials[k]["id"] for k in ("chair", "rover", "veg", "nologin", "nocert")]
    s, inv = c.post(f"/api/tournaments/{tid}/assignments/bulk", {"official_ids": invite_ids})
    if ok(s, "bulk-invite 5 officials", 201):
        check("bulk created 5 pending assignments", inv["created_count"] == 5,
              f"got {inv['created_count']}")

    def asg_id(key):
        s, lst = c.get(f"/api/tournaments/{tid}/assignments")
        for a in lst:
            if a["official_id"] == officials[key]["id"]:
                return a["id"], a
        return None, None

    def add_day(aid, day, role):
        s, _ = c.post(f"/api/assignments/{aid}/days", {"work_date": day, "working_as": role})
        return s

    a_chair, _ = asg_id("chair")
    a_rover, _ = asg_id("rover")
    a_veg, _ = asg_id("veg")
    a_nologin, _ = asg_id("nologin")
    a_nocert, _ = asg_id("nocert")

    # chair umpire at the Tennis Center on days 1+2 only → DAY 3 ends up UNCOVERED
    c.put(f"/api/assignments/{a_chair}", {"official_id": officials["chair"]["id"], "site_id": site_ids["A"]})
    add_day(a_chair, DAYS[0], "chair_umpire")
    add_day(a_chair, DAYS[1], "chair_umpire")
    step(f"{nm('chair')} (chair) → site A, days 1–2 (day 3 left uncovered on purpose)")

    # rover at the Racquet Club days 1+2, WITH a distance so mileage computes
    c.put(f"/api/assignments/{a_rover}", {"official_id": officials["rover"]["id"], "site_id": site_ids["B"]})
    add_day(a_rover, DAYS[0], "roving_official")
    add_day(a_rover, DAYS[1], "roving_official")
    # 60 one-way miles → reimbursable: clamp((2·60−50)·0.65,0,100) = $45.50 (>0).
    s, _ = c.post("/api/distances", {"official_id": officials["rover"]["id"],
                                     "site_id": site_ids["B"], "one_way_miles": 60, "source": "manual"})
    ok(s, f"{nm('rover')}↔Racquet Club distance on file", 201)

    # dietary chair → official room block (lodging) + day 1; no distance (mileage gap)
    c.put(f"/api/assignments/{a_veg}", {"official_id": officials["veg"]["id"],
                                        "site_id": site_ids["A"], "room_block_id": block_id})
    add_day(a_veg, DAYS[0], "chair_umpire")
    step(f"{nm('veg')} → site A + room block, day 1 (no distance on file → mileage gap)")

    # the no-cert official → an uncertified worked day is allowed but flagged
    s = add_day(a_nocert, DAYS[1], "chair_umpire")
    check("uncertified day accepted (no-cert official, flag-not-block)", s in (200, 201),
          f"HTTP {s}")

    # the no-login official gets a day too → surfaces in officials-without-login
    add_day(a_nologin, DAYS[0], "chair_umpire")

    # cross-tournament HARD double-booking: the chair also works T2 day 1 at site B
    s, inv2 = c.post(f"/api/tournaments/{t2id}/assignments/bulk",
                     {"official_ids": [officials["chair"]["id"]]})
    ok(s, f"invite {nm('chair')} to the 2nd tournament", 201)
    s, lst2 = c.get(f"/api/tournaments/{t2id}/assignments")
    a_chair2 = next((a["id"] for a in lst2 if a["official_id"] == officials["chair"]["id"]), None)
    c.put(f"/api/assignments/{a_chair2}", {"official_id": officials["chair"]["id"], "site_id": site_ids["B"]})
    add_day(a_chair2, DAYS[0], "chair_umpire")
    step(f"{nm('chair')} double-booked: both tournaments, same day, different venues")

    # ---- P6: official self-service responses (accept / decline) -------------
    phase("P6 — Officials respond (self-service): accept / decline")

    def as_official(key):
        creds = officials[key]["creds"]
        if not creds:
            return None
        oc = Client(base_url)
        s, _ = oc.post("/api/auth/login", {"username": creds[0], "password": creds[1]})
        return oc if s == 200 else None

    oc = as_official("chair")
    if oc:
        s, mine = oc.get("/api/me/assignments")
        ok(s, f"{nm('chair')} sees their assignments (self-service)", 200)
        s, _ = oc.post(f"/api/me/assignments/{a_chair}/respond", {"status": "accepted"})
        ok(s, f"{nm('chair')} accepts", 200)
    ocb = as_official("rover")
    if ocb:
        s, _ = ocb.post(f"/api/me/assignments/{a_rover}/respond", {"status": "declined"})
        ok(s, f"{nm('rover')} declines (→ re-staff challenge)", 200)

    s, declined = c.get(f"/api/tournaments/{tid}/declined")
    if ok(s, "declined-assignment list", 200):
        check(f"{nm('rover')}'s decline is surfaced for re-staffing", declined["count"] >= 1,
              f"got {declined['count']}")

    # ---- P7: withdrawal → promote alternate ---------------------------------
    phase("P7 — Withdrawal → promote alternate")
    s, wd = c.post(f"/api/tournaments/{tid}/withdrawals", {
        "usta_number": p_withdraw, "first_name": pw[0], "last_name": pw[1],
        "gender": "female", "reason": "injury"})
    ok(s, f"record withdrawal ({pw[0]} {pw[1]})", 201)
    s, alts = c.get(f"/api/tournaments/{tid}/alternates?age_division=G16")
    if ok(s, "same-division alternates after withdrawal", 200):
        if check("an alternate is suggested", len(alts) >= 1, f"got {len(alts)}"):
            s, _ = c.post(f"/api/roster/{alts[0]['id']}/promote")
            ok(s, "promote alternate → selected", 200)

    # ---- P8: the TD's review surfaces — does each challenge show up? --------
    phase("P8 — Verify challenges surface where the TD looks")

    s, rdy = c.get(f"/api/tournaments/{tid}/readiness")
    if ok(s, "readiness scorecard", 200):
        by = {x["key"]: x["status"] for x in rdy["checks"]}
        step(f"readiness: ready={rdy['ready']} · {rdy['summary']}")
        check("readiness flags it NOT ready", rdy["ready"] is False, str(rdy["summary"]))
        check("coverage fails (day 3 uncovered)", by.get("coverage") == "fail", str(by))
        check("conflicts fail (double-book + uncertified)", by.get("conflicts") == "fail", str(by))
        check(f"declined fails ({nm('rover')})", by.get("declined") == "fail", str(by))

    s, conf = c.get(f"/api/tournaments/{tid}/conflicts")
    if ok(s, "conflict report", 200):
        step(f"conflicts: {conf['counts']}")
        check("a hard double-booking is reported", conf["counts"]["hard_double_bookings"] >= 1,
              str(conf["counts"]))
        check("an uncertified day is reported", conf["counts"]["uncertified"] >= 1,
              str(conf["counts"]))

    s, dash = c.get(f"/api/tournaments/{tid}/dashboard")
    if ok(s, "tournament dashboard", 200):
        check("dashboard shows an uncovered day", dash["coverage"]["uncovered_days_count"] >= 1,
              str(dash["coverage"]))
        check("dashboard conflict count > 0", dash["conflicts"] >= 1, str(dash["conflicts"]))

    # coverage gap → candidates → fill it (day 3 chair)
    s, cands = c.get(f"/api/tournaments/{tid}/coverage-candidates?role=chair_umpire&date={DAYS[2]}")
    if ok(s, "coverage candidates for the uncovered day", 200):
        if check("certified candidates exist for the gap", len(cands) >= 1, f"got {len(cands)}"):
            cand = cands[0]
            s, _ = c.post(f"/api/tournaments/{tid}/coverage-fill", {
                "official_id": cand["official_id"], "work_date": DAYS[2], "working_as": "chair_umpire"})
            ok(s, "fill the coverage gap in one click", 201)
            s, dash2 = c.get(f"/api/tournaments/{tid}/dashboard")
            check("uncovered-day count dropped after fill",
                  dash2["coverage"]["uncovered_days_count"] < dash["coverage"]["uncovered_days_count"],
                  f"{dash['coverage']['uncovered_days_count']} → {dash2['coverage']['uncovered_days_count']}")

    s, md = c.get(f"/api/tournaments/{tid}/missing-distances")
    if ok(s, "missing-distance report", 200):
        check(f"{nm('veg')}↔site-A missing distance is flagged", md["count"] >= 1, f"got {md['count']}")

    s, nl = c.get(f"/api/tournaments/{tid}/officials-without-login")
    if ok(s, "officials-without-login report", 200):
        ids = [o["official_id"] for o in nl["officials"]]
        check(f"{nm('nologin')} (no login) is flagged as assigned-but-can't-respond",
              officials["nologin"]["id"] in ids,
              [o["official_name"] for o in nl["officials"]])

    s, diet = c.get(f"/api/tournaments/{tid}/dietary-summary")
    if ok(s, "dietary summary", 200):
        labels = [i["restriction"].lower() for i in diet["items"]]
        check(f"{nm('veg')}'s vegetarian restriction rolls up", "vegetarian" in labels, str(labels))

    s, room = c.get(f"/api/tournaments/{tid}/rooming-list")
    if ok(s, "rooming list", 200):
        occ = sum(len(b["occupants"]) for b in room["blocks"])
        check(f"{nm('veg')} appears as a room occupant", occ >= 1, f"{occ} occupants")

    s, sched = c.get(f"/api/tournaments/{tid}/schedule")
    if ok(s, "day-by-day schedule", 200):
        worked_days = sum(1 for d in sched["days"] if d["count"] > 0)
        check("schedule shows worked days", worked_days >= 1, str(worked_days))

    s, wl = c.get("/api/officials/workload")
    if ok(s, "official workload (cross-tournament)", 200):
        check("workload lists officials busiest-first", wl["totals"]["assignments"] >= 1,
              str(wl["totals"]))

    s, ps = c.get(f"/api/officials/{officials['rover']['id']}/pay-statement")
    if ok(s, f"per-official pay statement ({nm('rover')})", 200):
        check(f"{nm('rover')}'s statement has mileage (distance on file)",
              (ps["totals"]["mileage"] or 0) > 0, str(ps["totals"]))

    s, batch_ps = c.get(f"/api/tournaments/{tid}/pay-statements")
    ok(s, "batch pay statements", 200)
    s, inv_txt = c.get(f"/api/tournaments/{tid}/invite-texts")
    if ok(s, "tournament-wide invite texts", 200):
        check("invite text generated per assigned official", inv_txt["count"] >= 1,
              str(inv_txt["count"]))

    # cross-tournament rollups
    s, digest = c.get("/api/dashboard/digest")
    if ok(s, "cross-tournament digest", 200):
        row = next((t for t in digest["tournaments"] if t["tournament_id"] == tid), None)
        check("our tournament appears in the digest with open tasks",
              row is not None and row["open_tasks"] >= 1, str(row and row["open_tasks"]))
    s, dl = c.get("/api/dashboard/deadlines")
    if ok(s, "cross-tournament deadline radar", 200):
        check("our registration/late deadlines surface",
              any(d["tournament_id"] == tid for d in dl["deadlines"]),
              "tournament not in deadline window")

    s, aging = c.get(f"/api/emails/aging?tournament_id={tid}")
    ok(s, "inbox aging", 200)
    s, avail_grid = c.get(f"/api/tournaments/{tid}/availability/grid")
    if ok(s, "availability heatmap grid", 200):
        check("availability grid has officials", len(avail_grid["officials"]) >= 1,
              str(len(avail_grid["officials"])))

    # ---- summary ------------------------------------------------------------
    phase("Summary")
    print(f"  checks: {_checks['pass']} passed, {_checks['fail']} failed")
    print(f"  discoveries: {len(DISCOVERIES)}")
    print(f"  created tournaments {tid} & {t2id} (realistic names) — left in the DB for inspection")
    return tid, t2id


def write_findings(base_url, tid, t2id):
    path = "docs/e2e-findings.md"
    lines = [
        f"\n## E2E run {RUN} — {TODAY.isoformat()}\n",
        f"- Target: `{base_url}` · tournaments {tid} (junior) + {t2id} (adult).",
        f"- Checks: **{_checks['pass']} passed, {_checks['fail']} failed**; "
        f"{len(DISCOVERIES)} discovery(ies).",
    ]
    if DISCOVERIES:
        lines.append("- Discoveries:")
        lines += [f"  - {d}" for d in DISCOVERIES]
    else:
        lines.append("- No discoveries — every challenge surfaced where expected.")
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print(f"  findings appended to {path}")
    except OSError as e:
        print(f"  (could not write findings: {e})")


def main():
    ap = argparse.ArgumentParser(description="CourtOps end-to-end TD scenario driver")
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--write-findings", action="store_true",
                    help="append a dated section to docs/e2e-findings.md")
    args = ap.parse_args()
    tid, t2id = run(args.base_url)
    if args.write_findings:
        write_findings(args.base_url, tid, t2id)
    # Exit non-zero if any hard check failed, so CI / callers can gate on it.
    sys.exit(1 if _checks["fail"] else 0)


if __name__ == "__main__":
    main()
