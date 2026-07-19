"""API contract tests (improvement-plan P2 #14).

Two cheap hardening layers over the endpoints that return hand-built dicts
(no response_model, so FastAPI can't validate them):

1. SHAPE — the money/flag fields keep their types (float money, ISO-string
   dates, bool flags). Catches float-vs-string / null-vs-missing drift that
   the frontend would otherwise discover at runtime.
2. QUERY COUNT — a ceiling on queries-per-request for the hot list endpoints.
   Catches an accidental extra per-row (or per-day) query sneaking into
   _summary-style code. The ceilings are measured-now + headroom; raise them
   DELIBERATELY (with a comment) if the query plan legitimately changes.
"""
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

import app.db as db_mod
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


@pytest.fixture(scope="module")
def staffed():
    """One tournament with 3 assigned officials (cert + distance + 2 days each)."""
    # module-scoped setup runs BEFORE the function-scoped autouse login
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    site = _ok(client.post("/api/sites", json={"name": "CT " + uuid.uuid4().hex[:6]}))
    t = _ok(client.post("/api/tournaments", json={
        "name": "CT " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-08-01", "play_end_date": "2026-08-03"}))
    _ok(client.put(f"/api/tournaments/{t['id']}/sites",
                   json={"site_ids": [site["id"]]}), 200)
    asg_ids = []
    for i in range(3):
        o = _ok(client.post("/api/officials", json={
            "first_name": "Shape", "last_name": "Test" + uuid.uuid4().hex[:5]}))
        _ok(client.post(f"/api/officials/{o['id']}/certifications",
                        json={"cert_type": "roving_official"}))
        _ok(client.post("/api/distances", json={
            "official_id": o["id"], "site_id": site["id"],
            "one_way_miles": 60, "source": "manual"}))
        a = _ok(client.post(f"/api/tournaments/{t['id']}/assignments", json={
            "official_id": o["id"], "site_id": site["id"]}))
        for d in ("2026-08-01", "2026-08-02"):
            _ok(client.post(f"/api/assignments/{a['id']}/days", json={
                "work_date": d, "working_as": "roving_official"}))
        asg_ids.append(a["id"])
    return {"t": t, "site": site, "asg_ids": asg_ids}


# ------------------------------------------------------------------ shapes ----
def test_assignment_summary_shape(staffed):
    rows = _ok(client.get(f"/api/tournaments/{staffed['t']['id']}/assignments"), 200)
    assert len(rows) == 3
    s = rows[0]
    # money: real numbers, never strings (Decimal must be converted)
    assert isinstance(s["pay"], (int, float)) and isinstance(s["total"], (int, float))
    assert s["mileage"] is None or isinstance(s["mileage"], (int, float))
    assert isinstance(s["one_way_miles"], (int, float))
    # flags: real booleans
    for flag in ("missing_distance", "hotel_date_mismatch", "work_date_out_of_window",
                 "has_availability_data", "has_uncertified", "has_conflict",
                 "has_hard_conflict"):
        assert isinstance(s[flag], bool), flag
    # days: ISO-string dates + typed fields
    assert len(s["days"]) == 2
    d = s["days"][0]
    assert isinstance(d["work_date"], str) and len(d["work_date"]) == 10
    assert isinstance(d["rate_applied"], (int, float))
    for flag in ("conflict", "uncertified", "outside_availability"):
        assert isinstance(d[flag], bool), flag
    # lists present even when empty
    for key in ("conflicts", "official_other_dates", "available_dates",
                "held_certs", "uncertified_days", "days_outside_availability"):
        assert isinstance(s[key], list), key
    assert s["response_status"] in ("pending", "accepted", "declined")


def test_pay_statement_shape(staffed):
    rep = _ok(client.get(f"/api/tournaments/{staffed['t']['id']}/pay-statements"), 200)
    assert len(rep["officials"]) == 3
    st = rep["officials"][0]
    for k in ("pay", "total"):
        assert isinstance(st[k], (int, float)), k
    assert st["mileage"] is None or isinstance(st["mileage"], (int, float))
    for k in ("pay", "mileage", "total"):
        assert isinstance(rep["totals"][k], (int, float)), k


def test_officials_report_shape(staffed):
    rep = _ok(client.get(f"/api/tournaments/{staffed['t']['id']}/reports/officials"), 200)
    assert isinstance(rep["officials"], list) and len(rep["officials"]) == 3
    tot = rep["totals"]
    for k in ("pay", "mileage", "total"):
        assert isinstance(tot[k], (int, float)), k
    o = rep["officials"][0]
    assert isinstance(o["days"], list)
    assert isinstance(o["pay"], (int, float))


# ------------------------------------------------------------- query count ----
@pytest.fixture()
def qcount(monkeypatch):
    """Count every cur.execute() that runs through app.db.get_conn."""
    counts = {"n": 0}
    real = db_mod.get_conn

    class CountingCursor(psycopg.Cursor):
        def execute(self, *a, **k):
            counts["n"] += 1
            return super().execute(*a, **k)

    def patched():
        conn = real()
        conn.cursor_factory = CountingCursor
        return conn

    monkeypatch.setattr(db_mod, "get_conn", patched)
    return counts


def test_assignments_list_query_ceiling(staffed, qcount):
    """_summary runs ~5 queries per assignment (days, certs, distance, other
    bookings, availability) + the list query + auth. Measured ~20 for 3
    assignments; the ceiling leaves headroom but trips if a PER-DAY query
    (3 asgs x 2 days = +6) sneaks in. Raise deliberately, with a comment."""
    qcount["n"] = 0
    _ok(client.get(f"/api/tournaments/{staffed['t']['id']}/assignments"), 200)
    assert qcount["n"] <= 24, f"assignments list ran {qcount['n']} queries (ceiling 24)"


def test_players_list_query_ceiling(qcount):
    """paged_select = COUNT + SELECT (+ auth). Anything past 5 means a per-row
    query crept in."""
    qcount["n"] = 0
    _ok(client.get("/api/players?limit=50"), 200)
    assert qcount["n"] <= 5, f"players list ran {qcount['n']} queries (ceiling 5)"


def test_emails_list_query_ceiling(qcount):
    """COUNT + SELECT + auth; the lazy USTA backfill adds at most one UPDATE per
    legacy row — the test inbox has none, so the ceiling stays tight."""
    qcount["n"] = 0
    _ok(client.get("/api/emails?limit=50"), 200)
    assert qcount["n"] <= 6, f"emails list ran {qcount['n']} queries (ceiling 6)"
