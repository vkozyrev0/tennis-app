"""Assignment double-booking (cross-tournament conflict) detection tests.

A conflict = the same official worked on the same date in more than one
assignment. Within a single tournament an official has one assignment with a
unique role per date, so a same-day clash can only be cross-tournament. The
summary surfaces it as a flag (audit §3.4), distinguishing a *hard* conflict
(a different site that day — physically impossible) from a *soft* one (same /
no site — possibly a shared venue).

Named to sort last so its admin logins don't pre-empt a still-running module
(same rationale as test_zz_inbox).
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


@pytest.fixture(autouse=True)
def _ensure_admin_session():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _site():
    return _ok(client.post("/api/sites", json={"name": "Site " + uuid.uuid4().hex[:6]}))


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def _official_with_cert():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications",
                    json={"cert_type": "roving_official"}))
    return o


def _assign(tid, oid, site_id=None):
    if site_id is not None:
        # D5: site must be linked to the tournament (UI already enforces this).
        linked = [s["id"] for s in client.get(f"/api/tournaments/{tid}/sites").json()]
        if site_id not in linked:
            _ok(client.put(f"/api/tournaments/{tid}/sites",
                           json={"site_ids": linked + [site_id]}), 200)
    return _ok(client.post(f"/api/tournaments/{tid}/assignments",
                           json={"official_id": oid, "site_id": site_id}))


def _add_day(aid, work_date):
    return _ok(client.post(f"/api/assignments/{aid}/days",
                           json={"work_date": work_date, "working_as": "roving_official"}))


def _summary(tid, aid):
    return next(a for a in client.get(f"/api/tournaments/{tid}/assignments").json()
                if a["id"] == aid)


def test_hard_conflict_same_day_different_site():
    o = _official_with_cert()
    sa, sb = _site(), _site()
    t1, t2 = _tournament(), _tournament()
    a1 = _assign(t1["id"], o["id"], sa["id"])
    a2 = _assign(t2["id"], o["id"], sb["id"])
    # same date in both tournaments → impossible (two different sites)
    _add_day(a1["id"], "2026-06-02")
    _add_day(a2["id"], "2026-06-02")
    # a non-overlapping date only in t1 (control)
    _add_day(a1["id"], "2026-06-01")

    s = _summary(t1["id"], a1["id"])
    assert s["has_conflict"] is True
    assert s["has_hard_conflict"] is True            # different site that day
    clashing = {c["work_date"] for c in s["conflicts"]}
    assert clashing == {"2026-06-02"}
    assert s["conflicts"][0]["other_tournament_id"] == t2["id"]
    # per-day flag: the overlap is marked, the control date isn't
    by_date = {d["work_date"]: d["conflict"] for d in s["days"]}
    assert by_date["2026-06-02"] is True
    assert by_date["2026-06-01"] is False


def test_soft_conflict_when_no_site_on_the_other_booking():
    o = _official_with_cert()
    t1, t2 = _tournament(), _tournament()
    a1 = _assign(t1["id"], o["id"], _site()["id"])
    a2 = _assign(t2["id"], o["id"], None)            # no site on the other one
    _add_day(a1["id"], "2026-06-03")
    _add_day(a2["id"], "2026-06-03")
    s = _summary(t1["id"], a1["id"])
    assert s["has_conflict"] is True
    assert s["has_hard_conflict"] is False           # can't prove a site clash


def test_no_conflict_when_dates_dont_overlap():
    o = _official_with_cert()
    t1, t2 = _tournament(), _tournament()
    a1 = _assign(t1["id"], o["id"], _site()["id"])
    a2 = _assign(t2["id"], o["id"], _site()["id"])
    _add_day(a1["id"], "2026-06-01")
    _add_day(a2["id"], "2026-06-03")                 # different day → fine
    s = _summary(t1["id"], a1["id"])
    assert s["has_conflict"] is False
    assert s["conflicts"] == []


def test_official_other_dates_covers_unbooked_dates_for_add_precheck():
    """The add-day pre-check needs ALL dates the official works elsewhere — even
    ones not yet on THIS assignment (where has_conflict is still False)."""
    o = _official_with_cert()
    t1, t2 = _tournament(), _tournament()
    a1 = _assign(t1["id"], o["id"], _site()["id"])
    a2 = _assign(t2["id"], o["id"], _site()["id"])
    _add_day(a1["id"], "2026-06-01")                 # this assignment: only the 1st
    _add_day(a2["id"], "2026-06-02")                 # elsewhere: the 2nd
    s = _summary(t1["id"], a1["id"])
    assert s["has_conflict"] is False                # no overlap yet
    others = {d["work_date"] for d in s["official_other_dates"]}
    assert "2026-06-02" in others                    # but the pre-check can see it


def test_officials_report_counts_conflicts():
    o = _official_with_cert()
    t1, t2 = _tournament(), _tournament()
    a1 = _assign(t1["id"], o["id"], _site()["id"])
    a2 = _assign(t2["id"], o["id"], _site()["id"])
    _add_day(a1["id"], "2026-06-02")
    _add_day(a2["id"], "2026-06-02")                 # double-booked
    rep = client.get(f"/api/tournaments/{t1['id']}/reports/officials").json()
    assert rep["totals"]["conflict_count"] == 1
    me = next(x for x in rep["officials"] if x["id"] == a1["id"])
    assert me["has_conflict"] is True
