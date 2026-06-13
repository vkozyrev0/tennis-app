"""Payroll finalization (P4-4): freeze computed pay into payroll_record,
mark-paid lifecycle, drift detection, and the finalize-all sweep."""
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


def _staffed(n_days=2):
    o = _ok(client.post("/api/officials", json={
        "first_name": "Pay", "last_name": "R" + uuid.uuid4().hex[:6]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications",
                    json={"cert_type": "roving_official"}))
    t = _ok(client.post("/api/tournaments", json={
        "name": "PR " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-09-01", "play_end_date": "2026-09-04"}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                        json={"official_id": o["id"]}))
    s = None
    for i in range(n_days):
        s = _ok(client.post(f"/api/assignments/{a['id']}/days",
                            json={"work_date": f"2026-09-0{i + 1}",
                                  "working_as": "roving_official"}))
    return t, o, a, s


def test_finalize_freezes_the_computed_summary():
    t, o, a, s = _staffed()
    rec = _ok(client.post(f"/api/assignments/{a['id']}/finalize"))
    assert rec["assignment_id"] == a["id"]
    assert rec["total"] == s["total"]

    rows = _ok(client.get(f"/api/tournaments/{t['id']}/payroll"), 200)
    row = next(r for r in rows if r["assignment_id"] == a["id"])
    assert row["finalized"]["total"] == s["total"]
    assert row["finalized"]["pay"] == s["pay"]
    assert row["finalized"]["days_worked"] == 2
    assert row["finalized"]["finalized_by"] == "admin"
    assert row["drift"] is False
    # frozen day-by-day breakdown rides along for disputes
    assert row["finalized"]["paid"] is False


def test_finalize_twice_409():
    t, o, a, s = _staffed()
    _ok(client.post(f"/api/assignments/{a['id']}/finalize"))
    assert client.post(f"/api/assignments/{a['id']}/finalize").status_code == 409


def test_later_edits_do_not_move_finalized_money_but_flag_drift():
    t, o, a, s = _staffed()
    rec = _ok(client.post(f"/api/assignments/{a['id']}/finalize"))
    frozen_total = rec["total"]
    # day-of truth changes AFTER payment approval: one day becomes a no-show
    _ok(client.put(f"/api/assignment-days/{s['days'][0]['id']}/status",
                   json={"actual_status": "no_show"}), 200)
    rows = _ok(client.get(f"/api/tournaments/{t['id']}/payroll"), 200)
    row = next(r for r in rows if r["assignment_id"] == a["id"])
    assert row["finalized"]["total"] == frozen_total       # the freeze held
    assert row["total"] < frozen_total                     # live number moved
    assert row["drift"] is True                            # and the grid knows


def test_unfinalize_reopens_unless_paid():
    t, o, a, s = _staffed()
    rec = _ok(client.post(f"/api/assignments/{a['id']}/finalize"))
    # paid records refuse to unfinalize (two deliberate steps to walk back)
    _ok(client.put(f"/api/payroll/{rec['record_id']}/paid",
                   json={"paid": True, "paid_method": "check"}), 200)
    assert client.delete(f"/api/payroll/{rec['record_id']}").status_code == 409
    _ok(client.put(f"/api/payroll/{rec['record_id']}/paid", json={"paid": False}), 200)
    assert client.delete(f"/api/payroll/{rec['record_id']}").status_code == 204
    rows = _ok(client.get(f"/api/tournaments/{t['id']}/payroll"), 200)
    assert next(r for r in rows if r["assignment_id"] == a["id"])["finalized"] is None


def test_mark_paid_lifecycle_and_defaults():
    t, o, a, s = _staffed()
    rec = _ok(client.post(f"/api/assignments/{a['id']}/finalize"))
    paid = _ok(client.put(f"/api/payroll/{rec['record_id']}/paid",
                          json={"paid": True, "paid_method": "ach",
                                "paid_note": "batch 7"}), 200)
    assert paid["paid"] is True
    assert paid["paid_at"] is not None          # defaulted to today server-side
    assert paid["paid_method"] == "ach" and paid["paid_note"] == "batch 7"
    # walking it back clears the settlement fields
    unpaid = _ok(client.put(f"/api/payroll/{rec['record_id']}/paid",
                            json={"paid": False}), 200)
    assert unpaid["paid"] is False and unpaid["paid_at"] is None
    assert unpaid["paid_method"] is None and unpaid["paid_note"] is None


def test_finalize_all_is_idempotent_and_skips_finalized():
    t1, o1, a1, _ = _staffed()
    # second official on the same tournament
    o2 = _ok(client.post("/api/officials", json={
        "first_name": "Pay", "last_name": "S" + uuid.uuid4().hex[:6]}))
    _ok(client.post(f"/api/officials/{o2['id']}/certifications",
                    json={"cert_type": "roving_official"}))
    a2 = _ok(client.post(f"/api/tournaments/{t1['id']}/assignments",
                         json={"official_id": o2["id"]}))
    _ok(client.post(f"/api/assignments/{a2['id']}/days",
                    json={"work_date": "2026-09-02", "working_as": "roving_official"}))
    _ok(client.post(f"/api/assignments/{a1['id']}/finalize"))   # one already done

    out = _ok(client.post(f"/api/tournaments/{t1['id']}/payroll/finalize-all"), 200)
    assert out["finalized"] == 1 and out["total_finalized"] == 2
    again = _ok(client.post(f"/api/tournaments/{t1['id']}/payroll/finalize-all"), 200)
    assert again["finalized"] == 0 and again["total_finalized"] == 2


def test_payroll_lifecycle_lands_in_assignment_audit():
    t, o, a, s = _staffed()
    rec = _ok(client.post(f"/api/assignments/{a['id']}/finalize"))
    _ok(client.put(f"/api/payroll/{rec['record_id']}/paid", json={"paid": True}), 200)
    trail = _ok(client.get(f"/api/assignments/{a['id']}/audit"), 200)
    actions = [e["action"] for e in trail]
    assert "finalized" in actions and "paid" in actions


def test_multiple_orphaned_records_all_survive_in_summary():
    # Two officials finalized, then BOTH assignments deleted: each record's
    # assignment_id goes NULL (FK SET NULL). UNIQUE permits many NULLs, so the
    # summary must not collapse them onto one key — both must still show.
    t = _ok(client.post("/api/tournaments", json={
        "name": "ORPH " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-09-01", "play_end_date": "2026-09-02"}))
    recs = []
    for _ in range(2):
        o = _ok(client.post("/api/officials", json={
            "first_name": "Orph", "last_name": "R" + uuid.uuid4().hex[:6]}))
        _ok(client.post(f"/api/officials/{o['id']}/certifications",
                        json={"cert_type": "roving_official"}))
        a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments",
                            json={"official_id": o["id"]}))
        _ok(client.post(f"/api/assignments/{a['id']}/days",
                        json={"work_date": "2026-09-01", "working_as": "roving_official"}))
        recs.append(_ok(client.post(f"/api/assignments/{a['id']}/finalize")))
        assert client.delete(f"/api/assignments/{a['id']}").status_code == 204
    rows = _ok(client.get(f"/api/tournaments/{t['id']}/payroll"), 200)
    orphans = [r for r in rows if r.get("orphaned")]
    assert len(orphans) == 2, rows                      # neither dropped
    assert all(o["official_name"] for o in orphans)     # identity survived
    assert {o["finalized"]["record_id"] for o in orphans} == {r["record_id"] for r in recs}


def test_csv_export_lists_finalized_records():
    t, o, a, s = _staffed()
    rec = _ok(client.post(f"/api/assignments/{a['id']}/finalize"))
    _ok(client.put(f"/api/payroll/{rec['record_id']}/paid",
                   json={"paid": True, "paid_method": "check", "paid_note": "ck 1042"}), 200)
    r = client.get(f"/api/tournaments/{t['id']}/payroll/export.csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    body = r.content.decode("utf-8-sig")
    lines = [ln for ln in body.splitlines() if ln.strip()]
    assert lines[0].startswith("Official,Days worked,No-show days,Pay,Mileage,Total")
    # the official's row is present with the frozen total + paid columns
    row = next(ln for ln in lines[1:] if o["last_name"] in ln)
    assert f"{s['total']:.2f}" in row
    assert ",yes," in row and "check" in row and "ck 1042" in row


def test_csv_export_404_unknown_tournament():
    assert client.get("/api/tournaments/99999999/payroll/export.csv").status_code == 404


def test_finalize_404s():
    assert client.post("/api/assignments/99999999/finalize").status_code == 404
    assert client.delete("/api/payroll/99999999").status_code == 404
    assert client.put("/api/payroll/99999999/paid",
                      json={"paid": True}).status_code == 404
    assert client.get("/api/tournaments/99999999/payroll").status_code == 404
