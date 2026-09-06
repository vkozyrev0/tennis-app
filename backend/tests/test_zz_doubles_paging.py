"""Server-side doubles-request search + paging (q / limit / offset + X-Total-Count).

GET /api/tournaments/{id}/doubles returns `{requests, pairs}`; paging +
X-Total-Count apply to `requests` (the list the SPA pages). Distinct
divisions keep random requests from FIFO-pairing so we have three rows.
"""
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
    tag = "Dpage" + str(uuid.uuid4().int)[:6]
    t = _ok(client.post("/api/tournaments", json={
        "name": "D " + tag, "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))
    ids = []
    for first, div in [("Alice", "G10"), ("Bob", "G12"), ("Cara", "G14")]:
        usta = str(uuid.uuid4().int)[:10]
        _ok(client.post(f"/api/tournaments/{t['id']}/players", json={
            "usta_number": usta, "first_name": first, "last_name": tag,
            "gender": "female", "selection_status": "selected",
            "age_division": div,
        }))
        row = _ok(client.post(f"/api/tournaments/{t['id']}/doubles-requests", json={
            "usta_number": usta, "first_name": first, "last_name": tag,
            "wants_random": True, "age_division": div,
        }))
        ids.append(row["request"]["id"])
    return t["id"], tag, ids


def _reqs(r):
    body = _ok(r, 200)
    assert "requests" in body and "pairs" in body
    return body["requests"]


def test_q_filters_and_counts(trio):
    tid, tag, ids = trio
    r = client.get(f"/api/tournaments/{tid}/doubles?q={tag}")
    rows = _reqs(r)
    assert [p["id"] for p in rows] == ids
    assert r.headers["X-Total-Count"] == "3"


def test_limit_offset_page_disjoint(trio):
    tid, tag, ids = trio
    r1 = client.get(f"/api/tournaments/{tid}/doubles?q={tag}&limit=2")
    page1 = _reqs(r1)
    assert len(page1) == 2
    assert r1.headers["X-Total-Count"] == "3"
    page2 = _reqs(client.get(f"/api/tournaments/{tid}/doubles?q={tag}&limit=2&offset=2"))
    assert len(page2) == 1
    assert {p["id"] for p in page1}.isdisjoint({p["id"] for p in page2})
    assert {p["id"] for p in page1} | {p["id"] for p in page2} == set(ids)


def test_no_params_returns_all(trio):
    tid, tag, ids = trio
    r = client.get(f"/api/tournaments/{tid}/doubles")
    rows = _reqs(r)
    assert set(ids) <= {p["id"] for p in rows}
    assert r.headers["X-Total-Count"] == str(len(rows))
