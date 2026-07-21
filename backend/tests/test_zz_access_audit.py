"""PII view access audit (D19 — who opened player 360)."""
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


def _ok(r, code=200):
    assert r.status_code == code, r.text
    return r.json()


def test_player_360_is_logged():
    p = _ok(client.post("/api/players", json={
        "usta_number": "AA" + uuid.uuid4().hex[:8],
        "first_name": "View",
        "last_name": "Audit",
        "gender": "female",
        "birthdate": "2012-06-15",
    }), 201)
    ov = _ok(client.get(f"/api/players/{p['id']}/overview"))
    assert ov["player"]["id"] == p["id"]

    lst = _ok(client.get(
        f"/api/access-audit?resource_type=player&resource_id={p['id']}&limit=20"
    ))
    assert lst["total"] >= 1
    hit = next(
        i for i in lst["items"]
        if i["resource_id"] == p["id"] and i["action"] == "view_player_360"
    )
    assert hit["username"] == "admin"
    assert hit["resource_type"] == "player"
    assert hit["client_kind"] == "api"
    assert hit["detail"] is None or hit["detail"].get("surface") == "player_360"
    # Never store identity PII on the audit row itself.
    blob = str(hit)
    assert "View" not in blob and "Audit" not in blob
    assert p["usta_number"] not in blob


def test_player_360_with_tournament_scoped_log():
    t = _ok(client.post("/api/tournaments", json={
        "name": "T " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04",
    }), 201)
    p = _ok(client.post("/api/players", json={
        "usta_number": "BB" + uuid.uuid4().hex[:8],
        "first_name": "Scope",
        "last_name": "Tour",
        "gender": "male",
        "birthdate": "2011-01-01",
    }), 201)
    _ok(client.get(f"/api/players/{p['id']}/overview?tournament_id={t['id']}"))
    lst = _ok(client.get(
        f"/api/access-audit?resource_id={p['id']}&action=view_player_360&limit=10"
    ))
    assert any(i["tournament_id"] == t["id"] for i in lst["items"])


def test_missing_player_not_logged():
    before = _ok(client.get("/api/access-audit?limit=1"))
    total_before = before["total"]
    r = client.get("/api/players/999999999/overview")
    assert r.status_code == 404
    after = _ok(client.get("/api/access-audit?limit=1"))
    assert after["total"] == total_before


def test_unauthenticated_cannot_list_access_audit():
    anon = TestClient(app)
    assert anon.get("/api/access-audit").status_code == 401
