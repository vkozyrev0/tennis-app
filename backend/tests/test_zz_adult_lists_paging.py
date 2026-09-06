"""Server-side adult-list search + paging (scheduling-avoidances + division-flex)."""
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


def _tournament_players(tag):
    t = _ok(client.post("/api/tournaments", json={
        "name": "A " + tag, "type": "adult",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    players = []
    for first in ["Alice", "Bob", "Cara"]:
        usta = str(uuid.uuid4().int)[:10]
        _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "usta_number": usta, "first_name": first, "last_name": tag,
            "gender": "female", "selection_status": "selected",
        }))
        players.append((usta, first))
    return t["id"], players


@pytest.fixture()
def sched_trio():
    tag = "Spage" + str(uuid.uuid4().int)[:6]
    tid, players = _tournament_players(tag)
    ids = []
    for usta, first in players:
        row = _ok(client.post(f"/api/tournaments/{tid}/scheduling-avoidances", json={
            "usta_number": usta, "first_name": first, "last_name": tag,
            "avoid_day": "Saturday",
        }))
        ids.append(row["id"])
    return tid, tag, ids


@pytest.fixture()
def flex_trio():
    tag = "Fpage" + str(uuid.uuid4().int)[:6]
    tid, players = _tournament_players(tag)
    ids = []
    for usta, first in players:
        row = _ok(client.post(f"/api/tournaments/{tid}/division-flex", json={
            "usta_number": usta, "first_name": first, "last_name": tag,
            "home_division": "3.5",
        }))
        ids.append(row["id"])
    return tid, tag, ids


def test_sched_q_filters_and_counts(sched_trio):
    tid, tag, ids = sched_trio
    r = client.get(f"/api/tournaments/{tid}/scheduling-avoidances?q={tag}")
    rows = _ok(r, 200)
    assert [p["id"] for p in rows] == ids
    assert r.headers["X-Total-Count"] == "3"


def test_sched_limit_offset_page_disjoint(sched_trio):
    tid, tag, ids = sched_trio
    r1 = client.get(f"/api/tournaments/{tid}/scheduling-avoidances?q={tag}&limit=2")
    page1 = _ok(r1, 200)
    assert len(page1) == 2
    assert r1.headers["X-Total-Count"] == "3"
    page2 = _ok(client.get(
        f"/api/tournaments/{tid}/scheduling-avoidances?q={tag}&limit=2&offset=2"), 200)
    assert len(page2) == 1
    assert {p["id"] for p in page1}.isdisjoint({p["id"] for p in page2})
    assert {p["id"] for p in page1} | {p["id"] for p in page2} == set(ids)


def test_sched_no_params_returns_all(sched_trio):
    tid, tag, ids = sched_trio
    r = client.get(f"/api/tournaments/{tid}/scheduling-avoidances")
    rows = _ok(r, 200)
    assert set(ids) <= {p["id"] for p in rows}
    assert r.headers["X-Total-Count"] == str(len(rows))


def test_flex_q_filters_and_counts(flex_trio):
    tid, tag, ids = flex_trio
    r = client.get(f"/api/tournaments/{tid}/division-flex?q={tag}")
    rows = _ok(r, 200)
    assert [p["id"] for p in rows] == ids
    assert r.headers["X-Total-Count"] == "3"


def test_flex_limit_offset_page_disjoint(flex_trio):
    tid, tag, ids = flex_trio
    r1 = client.get(f"/api/tournaments/{tid}/division-flex?q={tag}&limit=2")
    page1 = _ok(r1, 200)
    assert len(page1) == 2
    assert r1.headers["X-Total-Count"] == "3"
    page2 = _ok(client.get(
        f"/api/tournaments/{tid}/division-flex?q={tag}&limit=2&offset=2"), 200)
    assert len(page2) == 1
    assert {p["id"] for p in page1}.isdisjoint({p["id"] for p in page2})
    assert {p["id"] for p in page1} | {p["id"] for p in page2} == set(ids)


def test_flex_no_params_returns_all(flex_trio):
    tid, tag, ids = flex_trio
    r = client.get(f"/api/tournaments/{tid}/division-flex")
    rows = _ok(r, 200)
    assert set(ids) <= {p["id"] for p in rows}
    assert r.headers["X-Total-Count"] == str(len(rows))
