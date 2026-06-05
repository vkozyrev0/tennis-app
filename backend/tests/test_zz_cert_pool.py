"""Certification pool in the officials report.

`cert_pool` lists every official + the certs they hold, plus a holder count per
cert, so the TD can plan role coverage against the available pool. It is global
(not tournament-scoped). Because the demo/seed DB may carry officials, the tests
assert on the specific officials they create rather than exact totals.

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
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-03"}))


def _official(last, *certs):
    o = _ok(client.post("/api/officials", json={"first_name": "P", "last_name": last}))
    for c in certs:
        _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": c}))
    return o


def _pool(tid):
    return client.get(f"/api/tournaments/{tid}/reports/officials").json()["cert_pool"]


def test_cert_pool_lists_each_officials_certs():
    t = _tournament()
    last = "Pool" + uuid.uuid4().hex[:6]
    _official(last, "chair_umpire", "roving_official")
    pool = _pool(t["id"])
    row = next(o for o in pool["officials"] if o["official_name"].startswith(last))
    assert sorted(row["certs"]) == ["chair_umpire", "roving_official"]


def test_cert_pool_counts_holders_per_cert():
    t = _tournament()
    tag = uuid.uuid4().hex[:6]
    _official("Ca" + tag, "chair_umpire")
    _official("Cb" + tag, "chair_umpire")
    _official("Rc" + tag, "roving_official")
    pool = _pool(t["id"])
    # at least the three we just added are reflected in the counts
    assert pool["counts"]["chair_umpire"] >= 2
    assert pool["counts"]["roving_official"] >= 1
    # the pool is global — these officials appear regardless of tournament roster
    names = {o["official_name"] for o in pool["officials"]}
    assert any(n.startswith("Ca" + tag) for n in names)


def test_official_with_no_certs_appears_with_empty_list():
    t = _tournament()
    last = "NoCert" + uuid.uuid4().hex[:6]
    _official(last)  # no certs
    row = next(o for o in _pool(t["id"])["officials"] if o["official_name"].startswith(last))
    assert row["certs"] == []
