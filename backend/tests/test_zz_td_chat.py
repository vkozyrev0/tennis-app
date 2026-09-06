"""TD chat planner: catalog from live OpenAPI, allowlist executor, confirm-before-write."""
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.td_chat import (
    ALLOWED_TOOLS,
    DEFAULT_CHAT_TIMEOUT_SEC,
    PLANNER_SYSTEM,
    TD_CHAT_VERDICT,
    TD_CHAT_VERDICT_DETAIL,
    build_catalog,
    parse_plan,
    planner_prompt,
    resolve_tool,
    run_resolved,
)

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)


@pytest.fixture(autouse=True)
def _admin():
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _tournament():
    return _ok(client.post("/api/tournaments", json={
        "name": "Chat " + uuid.uuid4().hex[:6], "type": "junior",
        "play_start_date": "2026-06-01", "play_end_date": "2026-06-04"}))


def test_catalog_from_live_openapi_includes_roster_and_status():
    cat = build_catalog(app)
    assert cat, "empty catalog"
    keys = {(r["method"], r["path"]) for r in cat}
    assert ("POST", "/api/tournaments/{tournament_id}/players") in keys
    assert ("DELETE", "/api/roster/{entry_id}") in keys
    assert ("GET", "/api/tournaments/{tournament_id}/dashboard") in keys
    add = next(r for r in cat
               if r["path"] == "/api/tournaments/{tournament_id}/players"
               and r["method"] == "POST")
    names = {p["name"] for p in add["params"]}
    assert "tournament_id" in names
    dash = next(r for r in cat if r["path"].endswith("/dashboard") and r["method"] == "GET")
    assert dash["path"].startswith("/api/")
    http = _ok(client.get("/api/td-chat/catalog"), 200)
    assert isinstance(http, list) and len(http) >= 10
    http_keys = {(r["method"], r["path"]) for r in http}
    assert ("POST", "/api/tournaments/{tournament_id}/players") in http_keys


def test_parse_plan_and_unknown_tool_rejected():
    plan = parse_plan(
        '{"calls":[{"tool":"tournament_status","args":{"tournament_id":3}},'
        '{"tool":"explode_db","args":{}}],"say":"ok"}'
    )
    assert [c["tool"] for c in plan["calls"]] == ["tournament_status", "explode_db"]
    resolve_tool("tournament_status", {"tournament_id": 3})
    with pytest.raises(Exception) as ei:
        resolve_tool("explode_db", {})
    assert "unknown tool" in str(ei.value.detail if hasattr(ei.value, "detail") else ei.value)


def test_executor_get_does_not_write_and_writes_need_confirm():
    t = _tournament()
    tid = t["id"]
    before = client.get(f"/api/tournaments/{tid}/players").json()
    n0 = len(before)
    status_call = resolve_tool("tournament_status", {"tournament_id": tid})
    got = run_resolved(client, [status_call], confirm=False)
    assert got[0]["status"] == 200
    assert "roster" in (got[0]["result"] or {})
    assert len(client.get(f"/api/tournaments/{tid}/players").json()) == n0

    usta = "2" + uuid.uuid4().hex[:9]
    add = resolve_tool("add_player", {
        "tournament_id": tid, "usta_number": usta, "first_name": "Ada",
        "last_name": "Chat", "gender": "female", "age_division": "G16",
    })
    skipped = run_resolved(client, [add], confirm=False)
    assert skipped[0]["status"] == "needs_confirm"
    names = {p["usta_number"] for p in client.get(f"/api/tournaments/{tid}/players").json()}
    assert usta not in names

    applied = run_resolved(client, [add], confirm=True)
    assert applied[0]["status"] in (200, 201), applied
    roster = client.get(f"/api/tournaments/{tid}/players").json()
    hit = next(p for p in roster if p["usta_number"] == usta)
    assert hit["first_name"] == "Ada"

    bogus = {"tool": "drop_all", "method": "DELETE", "path": "/api/nope",
             "json": None, "mutating": True}
    with pytest.raises(Exception):
        resolve_tool("drop_all", {})
    # Unknown tool never reaches HTTP — live table unchanged.
    assert len(client.get(f"/api/tournaments/{tid}/players").json()) == len(roster)

    rm = resolve_tool("remove_player", {"entry_id": hit["id"]})
    held = run_resolved(client, [rm], confirm=False)
    assert held[0]["status"] == "needs_confirm"
    assert any(p["id"] == hit["id"] for p in client.get(f"/api/tournaments/{tid}/players").json())
    gone = run_resolved(client, [rm], confirm=True)
    assert gone[0]["status"] in (200, 204)
    ids = {p["id"] for p in client.get(f"/api/tournaments/{tid}/players").json()}
    assert hit["id"] not in ids


def test_chat_turn_twice_returns_structured_body():
    t = _tournament()
    body = {"message": "What is the status of this tournament?",
            "tournament_id": t["id"]}
    r1 = client.post("/api/td-chat/turn", json=body)
    r2 = client.post("/api/td-chat/turn", json=body)
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text
    for r in (r1.json(), r2.json()):
        assert "reply" in r and "proposed" in r
        assert "llm" in r
        assert isinstance(r["proposed"], list)
    v = _ok(client.get("/api/td-chat/verdict"), 200)
    assert "verdict" in v and "detail" in v
    assert v["verdict"] == TD_CHAT_VERDICT
    assert v["detail"] == TD_CHAT_VERDICT_DETAIL


def test_turn_screenshot_cases_ignore_invented_tools_and_format_english(monkeypatch):
    t = _tournament()
    tid = t["id"]
    monkeypatch.setattr("app.routers.td_chat.llm_enabled", lambda: True)
    monkeypatch.setattr("app.routers.td_chat.probe_llm", lambda: "ok")

    def _llm(prompt):
        user = prompt.split("## User input", 1)[-1]
        if "\ntest\n" in user:
            return json.dumps({
                "calls": [{"tool": "tournament_status", "args": {"tournament_id": tid}},
                          {"tool": "say", "args": {}}],
                "say": "short confirmation",
            })
        return json.dumps({
            "calls": [{"tool": "tournament_status", "args": {"tournament_id": tid}},
                      {"tool": "me", "args": {}}],
            "say": "The current tournament is named 'Active Tournament'.",
        })

    monkeypatch.setattr("app.td_chat.chat_complete", _llm)
    help_r = client.post("/api/td-chat/turn", json={"message": "test", "tournament_id": tid})
    assert help_r.status_code == 200, help_r.text
    help_b = help_r.json()
    assert "short confirmation" not in (help_b["reply"] or "")
    assert help_b["unknown_tools"] == []
    assert "unfiled" not in (help_b["reply"] or "").lower() or "list the roster" in (help_b["reply"] or "").lower()
    assert not help_b["executed"]

    name_r = client.post("/api/td-chat/turn", json={
        "message": "what is the name of the current tournament", "tournament_id": tid,
    })
    assert name_r.status_code == 200, name_r.text
    name_b = name_r.json()
    assert t["name"] in (name_b["reply"] or "")
    assert "Active Tournament" not in (name_b["reply"] or "")
    assert name_b["unknown_tools"] == []


def test_turn_executes_status_get_on_shipped_route(monkeypatch):
    t = _tournament()
    monkeypatch.setattr("app.routers.td_chat.llm_enabled", lambda: True)
    monkeypatch.setattr("app.routers.td_chat.probe_llm", lambda: "ok")
    monkeypatch.setattr(
        "app.td_chat.chat_complete",
        lambda prompt: json.dumps({
            "calls": [{"tool": "tournament_status",
                       "args": {"tournament_id": t["id"]}}],
            "say": "status",
        }),
    )
    r = client.post("/api/td-chat/turn", json={
        "message": "status of this tournament", "tournament_id": t["id"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["executed"], body
    assert body["executed"][0]["status"] == 200
    assert "roster" in (body["executed"][0]["result"] or {})
    assert body["needs_confirm"] is False
    assert "roster" in (body["reply"] or "").lower() or body["executed"]


def test_execute_http_re_resolves_and_ignores_client_mutating_flag():
    t = _tournament()
    tid = t["id"]
    usta = "2" + uuid.uuid4().hex[:9]
    spoof = {
        "calls": [{
            "tool": "add_player",
            "args": {
                "tournament_id": tid, "usta_number": usta, "first_name": "Eve",
                "last_name": "Spoof", "gender": "female", "age_division": "G14",
            },
            "mutating": False,
            "method": "DELETE",
            "path": "/api/nope",
        }],
        "confirm": False,
        "tournament_id": tid,
    }
    held = client.post("/api/td-chat/execute", json=spoof)
    assert held.status_code == 200, held.text
    row = held.json()["executed"][0]
    assert row["status"] == "needs_confirm"
    assert row["mutating"] is True
    assert "/players" in row["path"]
    names = {p["usta_number"] for p in client.get(f"/api/tournaments/{tid}/players").json()}
    assert usta not in names

    applied = client.post("/api/td-chat/execute", json={**spoof, "confirm": True})
    assert applied.status_code == 200, applied.text
    assert applied.json()["applied"] is True
    assert applied.json()["executed"][0]["status"] in (200, 201)
    names = {p["usta_number"] for p in client.get(f"/api/tournaments/{tid}/players").json()}
    assert usta in names

    bad = client.post("/api/td-chat/execute", json={
        "calls": [{"tool": "drop_all", "args": {}, "mutating": False}],
        "confirm": True, "tournament_id": tid,
    })
    assert bad.status_code == 400
    assert "unknown tool" in bad.json()["detail"]


def test_chat_timeout_covers_markdown_catalog_prefill():
    assert DEFAULT_CHAT_TIMEOUT_SEC >= 180


def test_planner_prompt_is_short_and_isolates_user_input():
    p = planner_prompt("Add Jane to the roster", [], tournament_id=9)
    assert p.startswith("# CourtOps TD chat planner")
    assert "## User input" in p
    assert "Add Jane to the roster" in p[p.index("## User input"):]
    assert PLANNER_SYSTEM.startswith("You convert")
    assert "## Available APIs" not in p
