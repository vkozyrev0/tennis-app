"""Money audit trail (audit §5.3): the pay/mileage calc INPUTS are frozen on the
assignment (pay_audit), so a reimbursement is reproducible even after the
distance / rate changes (migration 0036)."""
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


def _summary(tid, aid):
    return next(a for a in client.get(f"/api/tournaments/{tid}/assignments").json() if a["id"] == aid)


def test_pay_audit_freezes_inputs_and_survives_distance_change():
    site = _ok(client.post("/api/sites", json={"name": "S " + uuid.uuid4().hex[:6]}))
    o = _ok(client.post("/api/officials", json={"first_name": "Aud", "last_name": "It " + uuid.uuid4().hex[:5]}))
    _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": "roving_official"}))
    # 25 one-way miles → reimbursable = (2*25-50)=0 → mileage 0; use 100 miles for a real number
    dist = _ok(client.post("/api/distances", json={
        "official_id": o["id"], "site_id": site["id"], "one_way_miles": 100, "source": "manual"}))
    t = _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={
        "official_id": o["id"], "site_id": site["id"]}))
    _ok(client.post(f"/api/assignments/{a['id']}/days", json={
        "work_date": "2026-06-02", "working_as": "roving_official"}))

    s = _summary(t["id"], a["id"])
    audit = s["pay_audit"]
    assert audit is not None
    # inputs are captured: the miles used + the rule constants + per-day rates
    assert audit["one_way_miles"] == 100.0
    assert audit["constants"] == {"free_miles": 50, "mileage_rate": 0.65, "mileage_cap": 100.0}
    assert audit["rule_version"] == s["rule_version"]
    assert len(audit["days"]) == 1 and audit["days"][0]["working_as"] == "roving_official"
    # mileage = clamp((2*100-50)*0.65, 0, 100) = clamp(97.5) = 97.5
    assert audit["mileage"] == 97.5 and s["mileage"] == 97.5

    # change the distance AFTER the snapshot → live mileage moves, audit stays frozen
    _ok(client.put(f"/api/distances/{dist['id']}", json={
        "official_id": o["id"], "site_id": site["id"], "one_way_miles": 10, "source": "manual"}), 200)
    s2 = _summary(t["id"], a["id"])
    assert s2["mileage"] == 0.0                       # live recompute: (2*10-50)<0 → 0
    assert s2["pay_audit"]["one_way_miles"] == 100.0  # frozen input unchanged
    assert s2["pay_audit"]["mileage"] == 97.5         # frozen output unchanged

    # re-snapshot (add a day) re-freezes the audit at the new distance
    _ok(client.post(f"/api/assignments/{a['id']}/days", json={
        "work_date": "2026-06-03", "working_as": "roving_official"}))
    s3 = _summary(t["id"], a["id"])
    assert s3["pay_audit"]["one_way_miles"] == 10.0
    assert s3["pay_audit"]["mileage"] == 0.0
