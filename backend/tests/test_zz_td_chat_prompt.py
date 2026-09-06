"""TD chat planner prompt + gold requests. No Postgres — these must always run."""
from __future__ import annotations

import json
import re
from pathlib import Path

from app.td_chat import (
    ALLOWED_TOOLS,
    HELP_TEXT,
    PLANNER_SYSTEM,
    allowed_calls,
    attach_remove_matches,
    build_catalog,
    detailed_catalog_md,
    extract_add_player_args,
    extract_remove_args,
    format_td_reply,
    infer_td_tools,
    parse_plan,
    plan_calls,
    planner_prompt,
)

GOLD_PATH = Path(__file__).parent / "fixtures" / "td_chat_requests.json"


def test_planner_prompt_few_shots_isolate_user_and_omit_full_catalog():
    cat = [
        {
            "method": "GET", "path": "/api/alpha",
            "purpose": "Alpha purpose",
            "params": [{"name": "id", "in": "path", "required": True}],
        },
        {
            "method": "POST", "path": "/api/beta",
            "purpose": "Beta purpose",
            "params": [{"name": "name", "in": "body", "required": False}],
        },
    ]
    p = planner_prompt("Add Jane to the roster", cat, tournament_id=9)
    assert p.startswith("# CourtOps TD chat planner")
    assert "## Task" in p
    assert "## Executable tools" in p
    assert "## Examples" in p
    assert "## User input" in p
    assert "## Available APIs" not in p
    assert "### `GET /api/alpha`" not in p
    user_at = p.index("## User input")
    assert "Add Jane to the roster" in p[user_at:]
    assert "string field" in p
    assert "never" in p.lower()
    assert "never a tool" in PLANNER_SYSTEM or "never" in PLANNER_SYSTEM
    assert "short confirmation" not in p.split("## User input")[0]
    for tool in ALLOWED_TOOLS:
        assert f"`{tool}`" in p
    from app.main import app
    live = build_catalog(app)
    live_prompt = planner_prompt("status?", live, tournament_id=1)
    dumped = sum(1 for row in live if f"{row['method']} {row['path']}" in live_prompt)
    assert dumped < 20, "full OpenAPI dump must stay out of the 1.5B planner prompt"
    md = detailed_catalog_md(cat)
    assert "### `GET /api/alpha`" in md
    assert PLANNER_SYSTEM.startswith("You convert")


def test_infer_td_tools_matches_gold_td_requests():
    gold = json.loads(GOLD_PATH.read_text(encoding="utf-8"))
    items = gold["items"]
    assert 30 <= len(items) <= 50
    prompt = planner_prompt("probe", [], tournament_id=1)
    missed_shots = []
    for row in items:
        got = infer_td_tools(row["message"])
        assert got == row["expect_tools"], (
            f"{row['id']}: {row['message']!r} -> {got} want {row['expect_tools']}"
        )
        for name in got:
            assert name in ALLOWED_TOOLS
        if row["id"] in {
            "help-test", "status-plain", "status-name", "list-plain",
            "add-jane", "remove-entry", "remove-jane",
        }:
            if row["message"] not in prompt and row["message"].rstrip(".") not in prompt:
                missed_shots.append(row["id"])
    assert missed_shots == [], f"screenshot/core few-shots missing from prompt: {missed_shots}"


def test_format_td_reply_uses_real_dashboard_and_roster_not_http_codes():
    dash = {
        "tournament": {
            "id": 2, "name": "Macon Junior Open 2026", "type": "junior",
            "play_start_date": "2026-09-18", "play_end_date": "2026-09-21",
            "registration_deadline": "2026-09-09", "late_entry_deadline": "2026-09-12",
        },
        "inbox": {"new": 7, "filed": 0, "needs_followup": 0},
        "roster": {"selected": 29, "alternate": 3, "withdrawn": 0, "total": 32},
        "officials": {"total": 7, "pending": 3, "accepted": 3, "declined": 1},
        "coverage": {"uncovered_days": [], "uncovered_days_count": 0},
        "rooms": {"reserved": 4, "assigned": 2, "unused": 2},
        "conflicts": 1,
    }
    roster = [
        {"id": 11, "first_name": "Ada", "last_name": "Chat",
         "usta_number": "1111111", "age_division": "G16", "selection_status": "selected"},
        {"id": 12, "first_name": "Bea", "last_name": "Roe",
         "usta_number": "2222222", "age_division": "G14", "selection_status": "alternate"},
    ]
    status_exec = [{"tool": "tournament_status", "status": 200, "result": dash}]
    list_exec = [{"tool": "list_roster", "status": 200, "result": roster}]

    help_txt = format_td_reply("test", executed=[], proposed=[], say="short confirmation")
    assert help_txt == HELP_TEXT
    assert "short confirmation" not in help_txt
    assert "unfiled" not in help_txt

    status = format_td_reply(
        "give me a status of the current tournament",
        executed=status_exec, proposed=[], say="short confirmation",
    )
    assert "Macon Junior Open 2026" in status
    assert "29 selected" in status
    assert "Inbox 7" in status or "7 unfiled" in status
    assert "short confirmation" not in status
    assert "Active Tournament" not in status
    assert not re.search(r"\b200\b", status)

    listed = format_td_reply(
        "give me a list of players in the current tournament",
        executed=list_exec, proposed=[], say="short confirmation",
    )
    assert "Ada Chat" in listed
    assert "Bea Roe" in listed
    assert "list_roster: 200" not in listed
    assert "short confirmation" not in listed

    named = format_td_reply(
        "what is the name of the current tournament",
        executed=status_exec, proposed=[],
        say="The current tournament is named 'Active Tournament'.",
    )
    assert named == "The current tournament is Macon Junior Open 2026."
    assert "Active Tournament" not in named
    assert "unfiled" not in named

    add_txt = format_td_reply(
        "Add Jane Roe, USTA 1234567, female, G16 to the roster.",
        executed=[],
        proposed=[{
            "tool": "add_player",
            "args": {
                "first_name": "Jane", "last_name": "Roe",
                "usta_number": "1234567", "gender": "female", "age_division": "G16",
            },
        }],
        say="short confirmation",
    )
    assert "Jane Roe" in add_txt
    assert "Confirm" in add_txt


def test_attach_remove_matches_fills_id_or_leaves_name():
    roster = [
        {"id": 11, "first_name": "Ada", "last_name": "Chat", "usta_number": "1111111"},
    ]
    hit = attach_remove_matches(
        [{"tool": "remove_player", "args": {"first_name": "Ada", "last_name": "Chat"}}],
        roster,
    )
    assert hit[0]["args"]["entry_id"] == 11
    miss = attach_remove_matches(
        [{"tool": "remove_player", "args": {"first_name": "Jane", "last_name": "Roe"}}],
        roster,
    )
    assert "entry_id" not in miss[0]["args"]
    reply = format_td_reply(
        "remove Jane Roe from the roster",
        executed=[{"tool": "list_roster", "status": 200, "result": roster}],
        proposed=miss,
    )
    assert reply == "Jane Roe is not on this roster."


def test_extract_remove_args_skips_roster_entry_as_a_name():
    got = extract_remove_args("Remove roster entry 42 from the tournament.")
    assert got.get("entry_id") == "42"
    assert "first_name" not in got
    named = extract_remove_args("remove Jane Roe from the roster")
    assert named.get("first_name") == "Jane"
    assert named.get("last_name") == "Roe"


def test_format_who_is_on_roster_lists_players_not_on_the():
    roster = [
        {"id": 11, "first_name": "Ada", "last_name": "Chat",
         "usta_number": "1111111", "age_division": "G16", "selection_status": "selected"},
    ]
    listed = format_td_reply(
        "who is on the roster",
        executed=[{"tool": "list_roster", "status": 200, "result": roster}],
        proposed=[], say="Looking up On The to remove.",
    )
    assert "Ada Chat" in listed
    assert "On The" not in listed
    missing = format_td_reply(
        "remove Jane Roe from the roster",
        executed=[{"tool": "list_roster", "status": 200, "result": roster}],
        proposed=[{"tool": "remove_player", "args": {"first_name": "Jane", "last_name": "Roe"}}],
        say="Looking up Jane Roe to remove.",
    )
    assert missing == "Jane Roe is not on this roster."
    assert "Looking up" not in missing


def test_extract_add_player_args_from_td_sentence():
    got = extract_add_player_args(
        "Add Jane Roe, USTA 1234567, female, G16 to the roster."
    )
    assert got["first_name"] == "Jane"
    assert got["last_name"] == "Roe"
    assert got["usta_number"] == "1234567"
    assert got["gender"] == "female"
    assert got["age_division"] == "G16"


def test_allowed_calls_drops_invented_say_and_me_tools():
    plan = parse_plan(
        '{"calls":[{"tool":"tournament_status","args":{"tournament_id":2}},'
        '{"tool":"say","args":{"short confirmation":"x"}},'
        '{"tool":"me","args":{}}],"say":"short confirmation"}'
    )
    kept = allowed_calls(plan["calls"])
    assert [c["tool"] for c in kept] == ["tournament_status"]
    assert infer_td_tools("test") == []
    assert infer_td_tools("give me a list of players in the current tournament") == [
        "list_roster",
    ]


def test_plan_calls_ignores_llm_status_on_test_and_keeps_add_args():
    bogus = [{"tool": "tournament_status", "args": {"tournament_id": 2}},
             {"tool": "say", "args": {}}]
    assert plan_calls("test", bogus) == []
    listed = plan_calls(
        "give me a list of players in the current tournament", bogus,
    )
    assert [c["tool"] for c in listed] == ["list_roster"]
    added = plan_calls(
        "Add Jane Roe, USTA 1234567, female, G16 to the roster.",
        [{"tool": "add_player", "args": {"first_name": "Jane"}}],
    )
    assert added[0]["tool"] == "add_player"
    assert added[0]["args"]["usta_number"] == "1234567"
    assert added[0]["args"]["age_division"] == "G16"
    assert added[0]["args"]["last_name"] == "Roe"
