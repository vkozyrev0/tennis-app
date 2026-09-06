"""Server-side roster search + paging (q / limit / offset + X-Total-Count)."""
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
    tag = "Rpage" + str(uuid.uuid4().int)[:6]
    t = _ok(client.post("/api/tournaments", json={
        "name": "R " + tag, "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    ids = []
    for first in ["Alice", "Bob", "Cara"]:
        row = _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "usta_number": str(uuid.uuid4().int)[:10],
            "first_name": first, "last_name": tag, "gender": "female",
            "selection_status": "selected",
        }))
        ids.append(row["id"])
    return t["id"], tag, ids


def test_q_filters_and_counts(trio):
    tid, tag, ids = trio
    r = client.get(f"/api/tournaments/{tid}/players?q={tag}")
    rows = _ok(r, 200)
    assert [p["id"] for p in rows] == ids
    assert r.headers["X-Total-Count"] == "3"


def test_limit_offset_page_disjoint(trio):
    tid, tag, ids = trio
    r1 = client.get(f"/api/tournaments/{tid}/players?q={tag}&limit=2")
    page1 = _ok(r1, 200)
    assert len(page1) == 2
    assert r1.headers["X-Total-Count"] == "3"
    page2 = _ok(client.get(f"/api/tournaments/{tid}/players?q={tag}&limit=2&offset=2"), 200)
    assert len(page2) == 1
    assert {p["id"] for p in page1}.isdisjoint({p["id"] for p in page2})
    assert {p["id"] for p in page1} | {p["id"] for p in page2} == set(ids)


def test_no_params_returns_all(trio):
    tid, tag, ids = trio
    r = client.get(f"/api/tournaments/{tid}/players")
    rows = _ok(r, 200)
    assert set(ids) <= {p["id"] for p in rows}
    assert r.headers["X-Total-Count"] == str(len(rows))
