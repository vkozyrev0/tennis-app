"""H4.2 — gate bulk export of minors' PII (can_export_pii + confirm).

Unit tests need no DB. Integration tests skip when Postgres is down (and when
pytest conftest cannot reset courtops_test).
"""
import uuid

import pytest
from fastapi import HTTPException

from app.export_gate import is_minors_pii_resource, redact_matrix, require_can_export_pii


def test_resource_classification():
    assert is_minors_pii_resource("players") is True
    assert is_minors_pii_resource("roster") is True
    assert is_minors_pii_resource("sign-in-sheet-foo") is True
    assert is_minors_pii_resource("emails") is True
    assert is_minors_pii_resource("payroll") is False
    assert is_minors_pii_resource("assignment_audit") is False
    assert is_minors_pii_resource("rates") is False
    assert is_minors_pii_resource("sites") is False


def test_redact_matrix_drops_contact_columns():
    m = [
        ["usta_number", "first_name", "emails", "phones", "birthdate"],
        ["1", "A", "a@x.com", "555", "2012-01-01"],
    ]
    out = redact_matrix(m)
    assert out[0] == ["usta_number", "first_name"]
    assert out[1] == ["1", "A"]


def test_require_can_export_pii_unit():
    require_can_export_pii({"role": "admin", "can_export_pii": True})
    # redacted=True skips capability (used by call sites that already stripped)
    require_can_export_pii({"role": "admin", "can_export_pii": False}, redacted=True)
    with pytest.raises(HTTPException) as ei:
        require_can_export_pii({"role": "admin", "can_export_pii": False})
    assert ei.value.status_code == 403


def _client_if_db():
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    try:
        if client.get("/api/health").json().get("db") != "ok":
            pytest.skip("Postgres not reachable / not migrated")
    except Exception:
        pytest.skip("Postgres not reachable / not migrated")
    return client, app


def test_export_audit_requires_confirm_for_players():
    client, _app = _client_if_db()
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    r = client.post("/api/export-audit", json={
        "resource": "players",
        "detail": {"filename": "players.csv", "row_count": 1},
    })
    assert r.status_code == 400, r.text
    r2 = client.post("/api/export-audit", json={
        "resource": "players",
        "detail": {"filename": "players.csv", "row_count": 1, "confirmed": True},
    })
    assert r2.status_code == 201, r2.text
    r3 = client.post("/api/export-audit", json={
        "resource": "rates",
        "detail": {"filename": "rates.csv", "row_count": 3},
    })
    assert r3.status_code == 201, r3.text


def test_new_admin_cannot_export_pii_until_granted():
    from fastapi.testclient import TestClient
    client, app = _client_if_db()
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    uname = "exp_" + uuid.uuid4().hex[:8]
    u = client.post("/api/admin/users", json={"username": uname, "password": "pw-export-1"}).json()
    assert u["can_export_pii"] is False

    other = TestClient(app)
    assert other.post("/api/auth/login", json={"username": uname, "password": "pw-export-1"}).status_code == 200
    me = other.get("/api/auth/me").json()
    assert me["can_export_pii"] is False

    denied = other.post("/api/export-audit", json={
        "resource": "players",
        "detail": {"filename": "players.csv", "row_count": 1, "confirmed": True},
    })
    assert denied.status_code == 403, denied.text

    assert client.patch(f"/api/admin/users/{u['id']}", json={"can_export_pii": True}).status_code == 200
    ok = other.post("/api/export-audit", json={
        "resource": "players",
        "detail": {"filename": "players.csv", "row_count": 1, "confirmed": True},
    })
    assert ok.status_code == 201, ok.text

    client.delete(f"/api/admin/users/{u['id']}")
