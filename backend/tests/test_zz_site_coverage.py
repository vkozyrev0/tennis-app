"""Per-site, per-day coverage in the officials report.

`site_coverage` reports officials per site per day across the play window. Rows
include every site linked to the tournament (so a fully-uncovered site still
shows) plus a synthetic "(no site)" row when an assignment has no venue.

Named to sort last (same rationale as the other test_zz modules)."""
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


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-02"}))


def _site():
    return _ok(client.post("/api/sites", json={"name": "Site " + uuid.uuid4().hex[:6]}))


def _link_sites(tid, *site_ids):
    _ok(client.put(f"/api/tournaments/{tid}/sites", json={"site_ids": list(site_ids)}), code=200)


def _official():
    o = _ok(client.post("/api/officials", json={
        "first_name": "Ref", "last_name": "Eree " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    return o


def _assign(tid, oid, site_id, *days):
    a = _ok(client.post(f"/api/tournaments/{tid}/assignments",
                        json={"official_id": oid, "site_id": site_id}))
    for d in days:
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": d, "working_as": "roving_official"}))
    return a


def _report(tid):
    return client.get(f"/api/tournaments/{tid}/reports/officials").json()


def _row(report, label):
    return next(s for s in report["site_coverage"] if s["site_label"] == label)


def test_per_site_per_day_counts():
    t = _tournament()
    sa, sb = _site(), _site()
    _link_sites(t["id"], sa["id"], sb["id"])
    o1, o2 = _official(), _official()
    _assign(t["id"], o1["id"], sa["id"], "2026-06-01")            # site A, day 1
    _assign(t["id"], o2["id"], sa["id"], "2026-06-01", "2026-06-02")  # site A, both days

    rep = _report(t["id"])
    a = {b["date"]: b["officials"] for b in _row(rep, sa["name"])["by_date"]}
    b = {b["date"]: b["officials"] for b in _row(rep, sb["name"])["by_date"]}
    assert a["2026-06-01"] == 2 and a["2026-06-02"] == 1
    # site B is linked but has nobody — still present, all zeros
    assert b["2026-06-01"] == 0 and b["2026-06-02"] == 0


def test_uncovered_site_still_listed():
    t = _tournament()
    s = _site()
    _link_sites(t["id"], s["id"])
    rep = _report(t["id"])
    row = _row(rep, s["name"])
    assert all(b["officials"] == 0 for b in row["by_date"])


def test_no_site_assignment_gets_synthetic_row():
    t = _tournament()
    s = _site()
    _link_sites(t["id"], s["id"])
    o = _official()
    _assign(t["id"], o["id"], None, "2026-06-01")   # assignment with NO site
    rep = _report(t["id"])
    nosite = _row(rep, "(no site)")
    counts = {b["date"]: b["officials"] for b in nosite["by_date"]}
    assert counts["2026-06-01"] == 1
    # the linked site is still its own row (zeros)
    assert _row(rep, s["name"])["by_date"][0]["officials"] == 0
