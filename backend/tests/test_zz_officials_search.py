"""Global official search + Official 360 overview (top-bar → official drawer).

`GET /api/officials/search?q=` finds officials by name; `GET
/api/officials/{id}/overview` returns core identity, certs held, and the
season pay summary (reused from assignments.pay_summary).

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


def _official(first, last, *certs):
    o = _ok(client.post("/api/officials", json={
        "first_name": first, "last_name": last, "city": "Austin", "state": "TX"}))
    for ct in certs:
        _ok(client.post(f"/api/officials/{o['id']}/certifications", json={"cert_type": ct}))
    return o


def _search(q, limit=10):
    return client.get(f"/api/officials/search?q={q}&limit={limit}").json()


def test_search_by_last_name():
    tag = uuid.uuid4().hex[:8]
    o = _official("Otto", "Quasar" + tag)
    hits = _search("Quasar" + tag)
    assert len(hits) == 1
    assert hits[0]["id"] == o["id"]
    assert hits[0]["last_name"].startswith("Quasar")
    assert hits[0]["city"] == "Austin"


def test_search_by_combined_form():
    tag = uuid.uuid4().hex[:8]
    _official("Wren" + tag, "Yarrow" + tag)
    assert any(h["first_name"].startswith("Wren")
               for h in _search(f"Yarrow{tag}, Wren{tag}"))


def test_short_query_returns_empty():
    assert _search("a") == []
    assert _search("") == []


def test_overview_core_and_certs():
    tag = uuid.uuid4().hex[:8]
    o = _official("Nova" + tag, "Pulsar" + tag, "roving_official", "chair_umpire")
    d = _ok(client.get(f"/api/officials/{o['id']}/overview"), 200)
    assert d["official"]["id"] == o["id"]
    assert set(d["certs"]) == {"roving_official", "chair_umpire"}
    assert d["pay"]["totals"]["assignments"] == 0
    assert d["pay"]["tournaments"] == []


def test_overview_404_for_missing():
    assert client.get("/api/officials/99999999/overview").status_code == 404
