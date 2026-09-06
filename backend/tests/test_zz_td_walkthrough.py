"""TD walkthrough bugs: blank inbox create, day-of incidents, venue site,
payroll vs assignments, readiness keys. Named to sort last."""
import uuid
from datetime import date, timedelta

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


def _tournament(start=None, end=None):
    start = start or (date.today() + timedelta(days=30)).isoformat()
    end = end or (date.today() + timedelta(days=32)).isoformat()
    return _ok(client.post("/api/tournaments", json={
        "name": "TDW " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": start, "play_end_date": end}))


def _official(cert="roving_official"):
    o = _ok(client.post("/api/officials", json={
        "first_name": "Walk", "last_name": uuid.uuid4().hex[:6]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications",
                    json={"cert_type": cert}))
    return o


def _site(tid=None):
    s = _ok(client.post("/api/sites", json={
        "code": "S" + uuid.uuid4().hex[:3], "name": "Site " + uuid.uuid4().hex[:5]}))
    if tid is not None:
        _ok(client.put(f"/api/tournaments/{tid}/sites", json={"site_ids": [s["id"]]}), 200)
    return s


def test_blank_email_create_rejected():
    t = _tournament()
    r = client.post("/api/emails", json={
        "tournament_id": t["id"], "from_address": "", "subject": "  ", "body": None,
    })
    assert r.status_code == 422, r.text
    # The shipped create path must not insert a blank row.
    inbox = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    assert inbox == []


def test_email_with_subject_still_creates():
    t = _tournament()
    em = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"], "subject": "Late entry please",
    }))
    assert em["subject"] == "Late entry please"
    assert em["status"] == "new"


def test_day_of_incident_lands_on_viewed_play_date():
    start = (date.today() + timedelta(days=40)).isoformat()
    end = (date.today() + timedelta(days=41)).isoformat()
    t = _tournament(start=start, end=end)
    day = _ok(client.get(f"/api/tournaments/{t['id']}/day-of?on={start}"), 200)
    assert day["date"] == start
    assert day["incidents"] == []

    # Omit occurred_at: outside the play window, create stamps play_start.
    inc = _ok(client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "weather", "severity": "minor",
        "description": "Rain delay courts 1-2",
    }))
    assert start in (inc.get("occurred_at") or "")

    day2 = _ok(client.get(f"/api/tournaments/{t['id']}/day-of?on={start}"), 200)
    assert len(day2["incidents"]) >= 1
    assert any(i["description"] == "Rain delay courts 1-2" for i in day2["incidents"])

    # Explicit stamp on the viewed day also shows up.
    _ok(client.post(f"/api/tournaments/{t['id']}/incidents", json={
        "category": "facility", "severity": "info",
        "description": "Net cord replaced",
        "occurred_at": start + "T12:00:00",
    }))
    day3 = _ok(client.get(f"/api/tournaments/{t['id']}/day-of?on={start}"), 200)
    assert len(day3["incidents"]) >= 2


def test_venue_day_without_site_rejected():
    t = _tournament()
    site = _site(t["id"])
    o = _official("chair_umpire")
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"]}))
    assert a.get("site_id") in (None, 0) or a.get("site_id") is None
    r = client.post(f"/api/assignments/{a['id']}/days", json={
        "work_date": t["play_start_date"], "working_as": "chair_umpire",
    })
    assert r.status_code == 400, r.text
    assert "site" in r.json()["detail"].lower()

    # Roving may omit a site.
    rover = _official("roving_official")
    ar = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                         json={"official_id": rover["id"]}))
    _ok(client.post(f"/api/assignments/{ar['id']}/days", json={
        "work_date": t["play_start_date"], "working_as": "roving_official",
    }))

    # Same chair with a site is accepted.
    o2 = _official("chair_umpire")
    a2 = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                         json={"official_id": o2["id"], "site_id": site["id"]}))
    _ok(client.post(f"/api/assignments/{a2['id']}/days", json={
        "work_date": t["play_start_date"], "working_as": "chair_umpire",
    }))


def test_payroll_lists_the_same_officials_as_assignments():
    t = _tournament()
    o = _official()
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days", json={
        "work_date": t["play_start_date"], "working_as": "roving_official",
    }))
    asg = _ok(client.get(f"/api/tournaments/{t['id']}/assignments"), 200)
    pay = _ok(client.get(f"/api/tournaments/{t['id']}/payroll"), 200)
    asg_ids = {row["id"] for row in asg}
    pay_ids = {row["assignment_id"] for row in pay}
    assert a["id"] in asg_ids
    assert a["id"] in pay_ids
    pay_row = next(r for r in pay if r["assignment_id"] == a["id"])
    asg_row = next(r for r in asg if r["id"] == a["id"])
    assert pay_row["official_id"] == asg_row["official_id"] == o["id"]


def test_readiness_includes_roster_staffing_site_coverage_incidents_schedule():
    t = _tournament()
    r = _ok(client.get(f"/api/tournaments/{t['id']}/readiness"), 200)
    keys = {c["key"] for c in r["checks"]}
    for need in ("roster", "staffing", "site_coverage", "incidents", "schedule"):
        assert need in keys, f"missing readiness check {need}: {keys}"


def test_roster_import_accepts_ntrp_and_rejects_blank_division():
    t = _ok(client.post("/api/tournaments", json={
        "name": "AD " + uuid.uuid4().hex[:6], "type": "adult",
        "play_start_date": "2026-10-01", "play_end_date": "2026-10-03"}))
    u_ok = str(uuid.uuid4().int % 10**10).zfill(10)
    u_blank = str(uuid.uuid4().int % 10**10).zfill(10)
    csv = (
        "usta_number,first_name,last_name,gender,age_division\n"
        f"{u_ok},Pat,Ace,male,NTRP 3.5 Men\n"
        f"{u_blank},Sam,Blank,female,\n"
    )
    up = _ok(client.post(f"/api/import/tournaments/{t['id']}/roster",
                         files={"file": ("r.csv", csv, "text/csv")}))
    assert up["total"] == 2
    assert up["valid"] == 1 and up["invalid"] == 1, up
    assert any("age division" in (e.get("error") or "").lower() for e in up["errors"])
    m = _ok(client.post(f"/api/import/batches/{up['batch_id']}/merge"), 200)
    assert m["merged"] == 1
    roster = _ok(client.get(f"/api/tournaments/{t['id']}/players"), 200)
    hit = next(e for e in roster if e["usta_number"] == u_ok)
    assert hit["age_division"] == "NTRP 3.5 Men"
    assert all(e["usta_number"] != u_blank for e in roster)


def test_pairing_change_classifies_as_doubles():
    from app.triage import classify
    assert classify(
        "Re: L3 Doubles pairing change",
        "Please change partners — Maya will play with a new partner this weekend.",
    ) == "doubles"
    assert classify(
        "Confirmed partnership",
        "Confirming doubles for this event. Thanks.",
    ) == "doubles"


def test_pdf_from_prefers_email_over_display_name():
    from app.importer import _parse_from_address
    assert _parse_from_address("Jane Doe <jane@example.com>") == "jane@example.com"
    assert _parse_from_address("Jane Doe", "Thanks\njane.parent@usta.com\n") == "jane.parent@usta.com"
    assert _parse_from_address("coach@club.org") == "coach@club.org"


def test_confirm_suggestions_links_parsed_usta():
    t = _tournament()
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    em = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "from_address": "parent@example.com",
        "subject": "Boys 14 doubles",
        "body": f"Please add Kate Hampton USTA# {usta} for doubles.",
    }))
    out = _ok(client.post("/api/emails/bulk/confirm-suggestions",
                          json={"email_ids": [em["id"]]}), 200)
    assert out["confirmed"] >= 1 or out["created"] >= 1
    got = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    row = next(x for x in got if x["id"] == em["id"])
    assert row["detected_player_id"] is not None
