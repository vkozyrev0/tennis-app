"""Server-side officials search + paging (q / limit / offset + X-Total-Count) —
the GET /api/players pattern extended to the officials list."""
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


@pytest.fixture()
def trio():
    """Three officials sharing a unique searchable last name, A/B/C first names
    so the last,first ORDER BY makes offset paging deterministic."""
    tag = "Pageoff" + str(uuid.uuid4().int)[:6]
    ids = []
    for first in ["Alice", "Bob", "Cara"]:
        o = _ok(client.post("/api/officials", json={
            "first_name": first, "last_name": tag, "city": "Pagetown", "state": "GA",
        }))
        ids.append(o["id"])
    return tag, ids


def test_q_filters_and_counts(trio):
    tag, ids = trio
    r = client.get(f"/api/officials?q={tag}")
    rows = _ok(r, 200)
    assert [o["id"] for o in rows] == ids
    assert r.headers["X-Total-Count"] == "3"


def test_q_matches_city(trio):
    tag, ids = trio
    rows = _ok(client.get("/api/officials?q=Pagetown"), 200)
    assert set(ids) <= {o["id"] for o in rows}


def test_limit_offset_page_disjoint(trio):
    tag, ids = trio
    r1 = client.get(f"/api/officials?q={tag}&limit=2")
    page1 = _ok(r1, 200)
    assert len(page1) == 2
    assert r1.headers["X-Total-Count"] == "3"
    page2 = _ok(client.get(f"/api/officials?q={tag}&limit=2&offset=2"), 200)
    assert len(page2) == 1
    assert {o["id"] for o in page1}.isdisjoint({o["id"] for o in page2})
    assert {o["id"] for o in page1} | {o["id"] for o in page2} == set(ids)


def test_no_params_returns_all(trio):
    tag, ids = trio
    r = client.get("/api/officials")
    rows = _ok(r, 200)
    assert set(ids) <= {o["id"] for o in rows}
    assert r.headers["X-Total-Count"] == str(len(rows))
