"""Export audit log (H4.1 / COPPA accountability — audit D1)."""
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
def _admin():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def test_browser_export_is_logged():
    # H4.2: minors-PII resources need detail.confirmed (or redacted).
    r = _ok(client.post("/api/export-audit", json={
        "resource": "players",
        "tournament_id": None,
        "detail": {"filename": "players.csv", "row_count": 12, "confirmed": True},
    }))
    assert r["ok"] is True and r["id"]
    lst = _ok(client.get("/api/export-audit?limit=20"), 200)
    assert lst["total"] >= 1
    hit = next(i for i in lst["items"] if i["id"] == r["id"])
    assert hit["username"] == "admin"
    assert hit["resource"] == "players"
    assert hit["client_kind"] == "browser"
    assert hit["detail"]["row_count"] == 12


def test_payroll_csv_logs_api_export():
    t = _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    # Empty payroll still returns CSV + should log.
    r = client.get(f"/api/tournaments/{t['id']}/payroll/export.csv")
    assert r.status_code == 200, r.text
    assert "text/csv" in r.headers.get("content-type", "")
    lst = _ok(client.get("/api/export-audit?resource=payroll&limit=10"), 200)
    assert any(
        i["resource"] == "payroll" and i["tournament_id"] == t["id"]
        and i["client_kind"] == "api"
        for i in lst["items"]
    )


def test_unauthenticated_cannot_log_or_list():
    anon = TestClient(app)
    assert anon.post("/api/export-audit", json={"resource": "x"}).status_code == 401
    assert anon.get("/api/export-audit").status_code == 401
