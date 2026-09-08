"""Inbox-parallel name+USTA people list and promote-to-Players (catalog, not roster)."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.inbox_person import split_name, upsert_inbox_people
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
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04",
    }))


def _usta():
    return str(uuid.uuid4().int % 10**10).zfill(10)


def test_split_name_space_and_comma():
    assert split_name("Jane Roe") == ("Jane", "Roe")
    assert split_name("Roe, Jane") == ("Jane", "Roe")
    assert split_name("  ") == (None, None)
    assert split_name("Cher") == ("Cher", None)


def test_upsert_inbox_people_skips_empty(monkeypatch):
    from app.db import get_conn
    with get_conn() as conn:
        with conn.cursor() as cur:
            assert upsert_inbox_people(cur, None, None) == []
            assert upsert_inbox_people(cur, None, [{"name": "", "usta": None}, "skip"]) == []
        conn.commit()


def test_upsert_attaches_usta_to_existing_name_only_person():
    """Name-only inbox person (first email) picks up USTA from a later email."""
    t = _tournament()
    e1 = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "L5 doubles",
        "body": (
            "Hi my son name is Ernesto Del Valle. His name is Ulrich Novakovitch. "
            "They want to pair up for doubles."
        ),
        "from_address": "a@example.com",
    }))
    _ok(client.put(f"/api/emails/{e1['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": None,
    }), 200)
    people = _ok(client.get("/api/inbox-people"), 200)
    ulrich = next(p for p in people if "ulrich" in (p.get("name") or "").lower())
    assert not ulrich.get("usta_number")
    usta = "2018838558"
    e2 = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "Doubles",
        "body": (
            "Hi. My son's name is Ulrich Novakovitch. His USTA # is "
            f"{usta}. Ernesto Del Valley asked if Ulrich can play doubles."
        ),
        "from_address": "b@example.com",
    }))
    _ok(client.put(f"/api/emails/{e2['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": None,
    }), 200)
    people2 = _ok(client.get("/api/inbox-people"), 200)
    ulrich2 = next(p for p in people2 if "ulrich" in (p.get("name") or "").lower())
    assert ulrich2["id"] == ulrich["id"]
    assert ulrich2["usta_number"] == usta


def test_stamp_email_fills_inbox_people_and_promote_creates_catalog():
    t = _tournament()
    u1, u2 = _usta(), _usta()
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "Girls 14 doubles",
        "body": (
            f"Please add Jane Roe USTA # {u1} for Girls 14 doubles "
            f"with Alex Kim USTA # {u2}."
        ),
        "from_address": "p@example.com",
    }))
    _ok(client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": None,
    }), 200)
    people = _ok(client.get("/api/inbox-people"), 200)
    by_usta = {p["usta_number"]: p for p in people if p.get("usta_number")}
    assert u1 in by_usta and u2 in by_usta
    jane = by_usta[u1]
    assert "jane" in (jane["name"] or "").lower() or (jane.get("first_name") or "").lower() == "jane"
    catalog = client.get(f"/api/players?q={u1}").json()
    assert not any(p.get("usta_number") == u1 for p in catalog)

    missing = client.post(f"/api/inbox-people/{jane['id']}/promote", json={})
    # Girls 14 infers female — if inferred, promote may succeed without body gender.
    if missing.status_code == 400:
        assert "gender" in missing.json()["detail"].lower()
        promoted = _ok(client.post(
            f"/api/inbox-people/{jane['id']}/promote", json={"gender": "female"},
        ), 200)
    else:
        promoted = _ok(missing, 200)
    assert promoted["player_id"]
    assert promoted["promoted_player_id"] == promoted["player_id"]
    found = client.get(f"/api/players?q={u1}").json()
    assert any(p.get("usta_number") == u1 and p["id"] == promoted["player_id"] for p in found)
    again = _ok(client.post(
        f"/api/inbox-people/{jane['id']}/promote", json={"gender": "female"},
    ), 200)
    assert again["player_id"] == promoted["player_id"]
    roster = _ok(client.get(f"/api/tournaments/{t['id']}/players"), 200)
    assert not any(r.get("player_id") == promoted["player_id"] or r.get("usta_number") == u1
                   for r in roster)


def test_promote_name_only_requires_usta_then_succeeds():
    t = _tournament()
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "L5 doubles",
        "body": (
            "Hi my son name is Ernesto Del Valle. His name is Ulrich Novakovitch. "
            "They want to pair up for doubles."
        ),
        "from_address": "p@example.com",
    }))
    _ok(client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": None,
    }), 200)
    people = _ok(client.get("/api/inbox-people"), 200)
    ernesto = next(p for p in people if "ernesto" in (p.get("name") or "").lower())
    assert not ernesto.get("usta_number")
    no_usta = client.post(
        f"/api/inbox-people/{ernesto['id']}/promote", json={"gender": "male"},
    )
    assert no_usta.status_code == 400
    assert "usta" in no_usta.json()["detail"].lower()
    usta = _usta()
    promoted = _ok(client.post(
        f"/api/inbox-people/{ernesto['id']}/promote",
        json={"gender": "male", "usta_number": usta},
    ), 200)
    assert promoted["player_id"]
    found = client.get(f"/api/players?q={usta}").json()
    assert any(p["id"] == promoted["player_id"] for p in found)
    one = _ok(client.get(f"/api/inbox-people/{ernesto['id']}"), 200)
    assert one["promoted_player_id"] == promoted["player_id"]


def test_inbox_people_404():
    assert client.get("/api/inbox-people/9999999").status_code == 404
    r = client.post("/api/inbox-people/9999999/promote", json={"gender": "male", "usta_number": "2018111000"})
    assert r.status_code == 404


def test_promote_without_gender_when_not_inferred():
    t = _tournament()
    e = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "subject": "doubles partners",
        "body": "Jordan Blake and Casey Ng would like to be doubles partners.",
        "from_address": "p@example.com",
    }))
    _ok(client.put(f"/api/emails/{e['id']}", json={
        "tournament_id": t["id"], "classification": "doubles",
        "status": "new", "detected_player_id": None,
    }), 200)
    people = _ok(client.get("/api/inbox-people"), 200)
    jordan = next(p for p in people if "jordan" in (p.get("name") or "").lower())
    usta = _usta()
    r = client.post(
        f"/api/inbox-people/{jordan['id']}/promote", json={"usta_number": usta},
    )
    assert r.status_code == 400
    assert "gender" in r.json()["detail"].lower()
