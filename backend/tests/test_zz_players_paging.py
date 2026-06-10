"""Server-side players search + paging (q / limit / offset + X-Total-Count) —
the GET /api/emails pattern extended to the players list (UI backlog)."""
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
    """Three players sharing a unique searchable last name, A/B/C first names
    so the last,first ORDER BY makes offset paging deterministic."""
    tag = "Pagetest" + str(uuid.uuid4().int)[:6]
    ids = []
    for i, first in enumerate(["Alice", "Bob", "Cara"]):
        p = _ok(client.post("/api/players", json={
            "usta_number": str(uuid.uuid4().int)[:10],
            "first_name": first, "last_name": tag, "gender": "female",
        }))
        ids.append(p["id"])
    return tag, ids


def test_q_filters_and_counts(trio):
    tag, ids = trio
    r = client.get(f"/api/players?q={tag}")
    rows = _ok(r, 200)
    assert [p["id"] for p in rows] == ids  # Alice, Bob, Cara by first name
    assert r.headers["X-Total-Count"] == "3"


def test_q_matches_usta_number(trio):
    tag, ids = trio
    usta = client.get(f"/api/players?q={tag}").json()[0]["usta_number"]
    rows = _ok(client.get(f"/api/players?q={usta}"), 200)
    assert [p["usta_number"] for p in rows] == [usta]


def test_limit_offset_page_disjoint(trio):
    tag, ids = trio
    r1 = client.get(f"/api/players?q={tag}&limit=2")
    page1 = _ok(r1, 200)
    assert len(page1) == 2
    assert r1.headers["X-Total-Count"] == "3"  # full match count, not page size
    page2 = _ok(client.get(f"/api/players?q={tag}&limit=2&offset=2"), 200)
    assert len(page2) == 1
    assert {p["id"] for p in page1}.isdisjoint({p["id"] for p in page2})
    assert {p["id"] for p in page1} | {p["id"] for p in page2} == set(ids)


def test_no_params_returns_all(trio):
    tag, ids = trio
    r = client.get("/api/players")
    rows = _ok(r, 200)
    assert set(ids) <= {p["id"] for p in rows}      # unpaged: everything is there
    assert r.headers["X-Total-Count"] == str(len(rows))


def test_q_combined_name_form(trio):
    """`Last, First` and `First Last` forms both match (combined-column ILIKE)."""
    tag, ids = trio
    rows = _ok(client.get(f"/api/players?q={tag}, Alice"), 200)
    assert [p["id"] for p in rows] == [ids[0]]
    rows = _ok(client.get(f"/api/players?q=Bob {tag}"), 200)
    assert [p["id"] for p in rows] == [ids[1]]
