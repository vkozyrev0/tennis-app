"""Global player search (top-bar → Player 360).

`GET /api/players/search?q=` finds players by name or USTA # (ILIKE on the
plaintext name/usta columns).

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


def _player(first, last, usta):
    _ok(client.post("/api/players", json={
        "usta_number": usta, "first_name": first, "last_name": last, "gender": "female"}))


def _search(q, limit=10):
    return client.get(f"/api/players/search?q={q}&limit={limit}").json()


def test_search_by_last_name():
    tag = uuid.uuid4().hex[:8]
    usta = str(uuid.uuid4().int % 10**10).zfill(10)
    _player("Maria", "Zephyr" + tag, usta)
    hits = _search("Zephyr" + tag)
    assert len(hits) == 1
    assert hits[0]["usta_number"] == usta
    assert hits[0]["last_name"].startswith("Zephyr")


def test_search_by_usta_number_fragment():
    tag = uuid.uuid4().hex[:8]
    usta = "29" + str(uuid.uuid4().int % 10**8).zfill(8)
    _player("Quill" + tag, "Vex" + tag, usta)
    hits = _search(usta[:6])
    assert any(h["usta_number"] == usta for h in hits)


def test_search_by_first_or_full_name():
    tag = uuid.uuid4().hex[:8]
    _player("Xander" + tag, "Quoll" + tag, str(uuid.uuid4().int % 10**10).zfill(10))
    assert any(h["first_name"].startswith("Xander") for h in _search("Xander" + tag))
    # "Last, First" combined form also matches
    assert any(h["first_name"].startswith("Xander")
               for h in _search(f"Quoll{tag}, Xander{tag}"))


def test_short_query_returns_empty():
    assert _search("a") == []
    assert _search("") == []


def test_limit_is_capped():
    # asking for a huge limit doesn't error (capped server-side)
    assert isinstance(_search("e", 9999), list)  # 'e' is len 1 → empty, but no error
    assert isinstance(_search("er", 9999), list)
