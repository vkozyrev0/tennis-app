"""TD chat planner: OpenAPI catalog + allowlisted API-call sequences.

The 1.5B sidecar sees a *short* tool list (quality collapses on a 40-router
dump). The full catalog from ``app.openapi()`` stays available via
``GET /api/td-chat/catalog``. Writes do not apply until ``confirm=True``.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from fastapi import HTTPException

# Keep in sync with docs/td-chat.md after the live 1.5B run.
TD_CHAT_VERDICT = "sufficient"
TD_CHAT_VERDICT_DETAIL = (
    "Qwen2.5-1.5B-Instruct Q4_K_M emitted valid allowlisted call sequences for "
    "tournament status, add player, and remove player (3/3) with a short tool "
    "list. Reply text often copies the prompt stub. Do not dump every router "
    "schema into the prompt — keep the small allowlist. Redeploy courtops-llm "
    "only if the GGUF changes."
)

ALLOWED_TOOLS = {
    "tournament_status": {
        "method": "GET",
        "path": "/api/tournaments/{tournament_id}/dashboard",
        "mutating": False,
        "params": ["tournament_id"],
        "purpose": "Tournament status: roster mix, inbox, officials, coverage.",
    },
    "list_roster": {
        "method": "GET",
        "path": "/api/tournaments/{tournament_id}/players",
        "mutating": False,
        "params": ["tournament_id"],
        "purpose": "List roster entries (id, names, USTA #, division).",
    },
    "add_player": {
        "method": "POST",
        "path": "/api/tournaments/{tournament_id}/players",
        "mutating": True,
        "params": ["tournament_id", "usta_number", "first_name", "last_name",
                   "gender", "age_division"],
        "purpose": "Add a player to the tournament roster.",
    },
    "remove_player": {
        "method": "DELETE",
        "path": "/api/roster/{entry_id}",
        "mutating": True,
        "params": ["entry_id"],
        "purpose": "Remove a roster entry by tournament_entry id.",
    },
}

_JSON_ARR = re.compile(r"\[.*\]", re.S)
_JSON_OBJ = re.compile(r"\{.*\}", re.S)


def build_catalog(app) -> list[dict]:
    """Machine-readable TD API catalog from the live FastAPI OpenAPI table."""
    spec = app.openapi()
    out: list[dict] = []
    for path, methods in (spec.get("paths") or {}).items():
        if not isinstance(methods, dict):
            continue
        for method, op in methods.items():
            if method.lower() not in {"get", "post", "put", "patch", "delete"}:
                continue
            if not isinstance(op, dict):
                continue
            params = []
            for p in op.get("parameters") or []:
                if not isinstance(p, dict):
                    continue
                params.append({
                    "name": p.get("name"),
                    "in": p.get("in"),
                    "required": bool(p.get("required")),
                })
            body_required: list[str] = []
            content = ((op.get("requestBody") or {}).get("content") or {})
            schema = ((content.get("application/json") or {}).get("schema") or {})
            # Inline or $ref — flatten one level of components if present.
            if "$ref" in schema:
                ref = schema["$ref"].rsplit("/", 1)[-1]
                schema = ((spec.get("components") or {}).get("schemas") or {}).get(ref) or {}
            props = schema.get("properties") or {}
            req = set(schema.get("required") or [])
            for name, spec_p in props.items():
                body_required.append(name)
                params.append({
                    "name": name,
                    "in": "body",
                    "required": name in req,
                })
            summary = (op.get("summary") or op.get("description") or
                       op.get("operationId") or "").split("\n", 1)[0].strip()
            out.append({
                "method": method.upper(),
                "path": path,
                "purpose": summary[:240],
                "params": params,
            })
    return out


def compact_catalog(catalog: list[dict], limit: int | None = None) -> str:
    """One-line-per-route dump (tests / compact views)."""
    rows = catalog if limit is None else catalog[:limit]
    lines = []
    for row in rows:
        lines.append(f"{row['method']} {row['path']} — {row.get('purpose') or ''}")
    if limit is not None and len(catalog) > limit:
        lines.append(f"… {len(catalog) - limit} more routes; GET /api/td-chat/catalog for all")
    return "\n".join(lines)


def detailed_catalog_md(catalog: list[dict]) -> str:
    """Markdown listing of every catalog route with purpose and parameters."""
    blocks = []
    for row in catalog:
        method = row.get("method") or ""
        path = row.get("path") or ""
        purpose = (row.get("purpose") or "").strip() or "(no summary)"
        lines = [f"### `{method} {path}`", "", purpose]
        params = row.get("params") or []
        if params:
            lines.append("")
            lines.append("Parameters:")
            for p in params:
                if not isinstance(p, dict):
                    continue
                name = p.get("name") or "?"
                loc = p.get("in") or "query"
                req = "required" if p.get("required") else "optional"
                lines.append(f"- `{name}` ({loc}, {req})")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def tools_prompt_block() -> str:
    lines = []
    for name, spec in ALLOWED_TOOLS.items():
        mut = "write — needs Confirm" if spec["mutating"] else "read"
        lines.append(
            f"- **`{name}`** — `{spec['method']} {spec['path']}`  \n"
            f"  {spec['purpose']}  \n"
            f"  Args: {', '.join(f'`{p}`' for p in spec['params'])}  \n"
            f"  Kind: {mut}"
        )
    return "\n".join(lines)


def parse_plan(raw: str | None) -> dict:
    """Pull {calls, say} from a model reply. Unknown shape → empty calls."""
    if not raw or not str(raw).strip():
        return {"calls": [], "say": ""}
    s = str(raw).strip()
    blob = None
    m = re.search(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", s, re.S)
    if m:
        blob = m.group(1)
    if blob is None:
        m2 = _JSON_OBJ.search(s) or _JSON_ARR.search(s)
        blob = m2.group(0) if m2 else None
    if not blob:
        return {"calls": [], "say": s[:500]}
    try:
        data = json.loads(blob)
    except json.JSONDecodeError:
        return {"calls": [], "say": s[:500]}
    calls_in = []
    say = ""
    if isinstance(data, list):
        calls_in = data
    elif isinstance(data, dict):
        calls_in = data.get("calls") or data.get("tools") or data.get("actions") or []
        say = str(data.get("say") or data.get("reply") or data.get("message") or "")
        if not calls_in and data.get("tool"):
            calls_in = [data]
    out = []
    for item in calls_in:
        if not isinstance(item, dict):
            continue
        name = (item.get("tool") or item.get("name") or item.get("function") or "").strip()
        args = item.get("args") or item.get("arguments") or item.get("params") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        if not isinstance(args, dict):
            args = {}
        if name:
            out.append({"tool": name, "args": args})
    return {"calls": out, "say": say.strip()}


HELP_TEXT = (
    "I can check this tournament's status, list the roster, or add or remove "
    "a player. What do you need?"
)

_STUB_SAY = re.compile(
    r"^\s*(short confirmation|ok|okay|status|done|sure)?\s*$", re.I,
)
_HELP_MSG = re.compile(
    r"^(test|ok|okay|thanks|thank you|thx|hi|hello|hey|yo|ping|help|"
    r"what can you do|what do you do|how does this work|\?+)$",
    re.I,
)
_ADD_MSG = re.compile(
    r"\b(add(?:\s+player)?|enter|register|put|late\s+entry(?:\s+for)?)\b", re.I,
)
_REMOVE_MSG = re.compile(
    r"\b(remove|drop|delete|take)\b|\bwithdraw\b(?!n)", re.I,
)
_ENTRY_ID_MSG = re.compile(r"\b(?:roster\s+)?entry\s+(\d+)\b|\bid\s+(\d+)\b", re.I)
_LIST_MSG = re.compile(
    r"\b(list|show(?:\s+me)?|who is on|who's on|who is in|names of|"
    r"find\b|is \w+ \w+ entered|players in)\b",
    re.I,
)
_STATUS_MSG = re.compile(
    r"\b(status|dashboard|how is|looking|coverage|inbox|unfiled|"
    r"officials?|room pickup|rooms?|conflicts?|ready|deadline|"
    r"play start|play end|how many|name of|what tournament|"
    r"selected vs|withdrawn|registration)\b",
    re.I,
)
_USTA_RE = re.compile(
    r"\b(?:usta\s*(?:#|no\.?|number)?\s*)(\d{6,10})\b|\b(\d{6,10})\b", re.I,
)
_DIV_RE = re.compile(r"\b([BG]\s*-?\s*(?:10|12|14|16|18))\b", re.I)
_GENDER_RE = re.compile(
    r"\b(female|male|girl|boy|woman|women|man|men|womens|mens)\b", re.I,
)
_ADD_NAME_RE = re.compile(
    r"\b(?:add(?:\s+player)?|enter|register|put|late\s+entry(?:\s+for)?)\s+"
    r"([a-z][a-z'-]+)\s+([a-z][a-z'-]+)",
    re.I,
)
_REMOVE_NAME_RE = re.compile(
    r"\b(?:remove|drop|delete|withdraw|take)\s+"
    r"(?!roster\s+entry)(?!player\s+entry)"
    r"([a-z][a-z'-]+)\s+([a-z][a-z'-]+)",
    re.I,
)


def infer_td_tools(message: str) -> list[str]:
    """Deterministic plan for a typical TD request (allowlisted tools only)."""
    raw = (message or "").strip()
    if not raw or _HELP_MSG.fullmatch(raw):
        return []
    if _ADD_MSG.search(raw):
        return ["add_player"]
    if _REMOVE_MSG.search(raw):
        if _ENTRY_ID_MSG.search(raw):
            return ["remove_player"]
        return ["list_roster", "remove_player"]
    if _STATUS_MSG.search(raw):
        return ["tournament_status"]
    if _LIST_MSG.search(raw):
        return ["list_roster"]
    if re.search(r"\b(tournament|event|weekend)\b", raw, re.I):
        return ["tournament_status"]
    return []


def extract_add_player_args(message: str) -> dict:
    """Pull add_player fields from a TD sentence. Missing keys are omitted."""
    raw = message or ""
    out: dict[str, str] = {}
    m = _ADD_NAME_RE.search(raw)
    if m:
        out["first_name"] = m.group(1).title()
        out["last_name"] = m.group(2).title()
    um = _USTA_RE.search(raw)
    if um:
        out["usta_number"] = next(g for g in um.groups() if g)
    gm = _GENDER_RE.search(raw)
    if gm:
        g = gm.group(1).lower()
        out["gender"] = "female" if g.startswith(("f", "g", "w")) else "male"
    dm = _DIV_RE.search(raw)
    if dm:
        token = re.sub(r"[\s-]", "", dm.group(1)).upper()
        out["age_division"] = token
    return out


def extract_remove_args(message: str) -> dict:
    raw = message or ""
    out: dict[str, str] = {}
    em = _ENTRY_ID_MSG.search(raw)
    if em:
        out["entry_id"] = next(g for g in em.groups() if g)
    nm = _REMOVE_NAME_RE.search(raw)
    if nm:
        out["first_name"] = nm.group(1).title()
        out["last_name"] = nm.group(2).title()
    return out


def allowed_calls(calls: list[dict] | None) -> list[dict]:
    """Keep only allowlisted tools so invented names like say/me never execute."""
    out = []
    for c in calls or []:
        if not isinstance(c, dict):
            continue
        name = (c.get("tool") or "").strip()
        if name in ALLOWED_TOOLS:
            args = c.get("args") if isinstance(c.get("args"), dict) else {}
            out.append({"tool": name, "args": dict(args)})
    return out


def plan_calls(message: str, llm_calls: list | None = None) -> list[dict]:
    """Merge sidecar JSON with the deterministic TD map.

    Help/nonsense (``test``, ``hello``) never runs an API even if the model
    emitted ``tournament_status``. If the model missed the mapped tools, use
    the map. ``fill_call_args`` still copies names/USTA from the sentence.
    """
    inferred = infer_td_tools(message)
    llm_calls = allowed_calls(llm_calls)
    if not inferred:
        return []
    names = [c["tool"] for c in llm_calls]
    if llm_calls and any(t in names for t in inferred):
        calls = llm_calls
    else:
        calls = [{"tool": n, "args": {}} for n in inferred]
    return fill_call_args(message, calls)


def fill_call_args(message: str, calls: list[dict]) -> list[dict]:
    """Fill missing add/remove args from the TD sentence (LLM holes)."""
    add_x = extract_add_player_args(message)
    rm_x = extract_remove_args(message)
    out = []
    for c in calls:
        args = dict(c.get("args") or {})
        if c["tool"] == "add_player":
            for k, v in add_x.items():
                if not args.get(k):
                    args[k] = v
            g = str(args.get("gender") or "").lower()
            if g in {"girl", "female", "woman", "women", "womens"}:
                args["gender"] = "female"
            elif g in {"boy", "male", "man", "men", "mens"}:
                args["gender"] = "male"
        elif c["tool"] == "remove_player":
            for k, v in rm_x.items():
                if not args.get(k):
                    args[k] = v
        out.append({**c, "args": args})
    return out


def attach_remove_matches(calls: list[dict], roster_rows: list) -> list[dict]:
    """Fill remove_player entry_id from a loaded roster when the TD used a name."""
    out = []
    for c in calls:
        if (c.get("tool") or "") != "remove_player":
            out.append(c)
            continue
        args = dict(c.get("args") or {})
        if args.get("entry_id"):
            out.append({**c, "args": args})
            continue
        hit = match_roster_entry(
            roster_rows,
            first_name=args.get("first_name"),
            last_name=args.get("last_name"),
            usta=args.get("usta_number") or args.get("usta"),
        )
        if hit:
            args["entry_id"] = hit["id"]
            args.setdefault("first_name", hit.get("first_name"))
            args.setdefault("last_name", hit.get("last_name"))
        out.append({**c, "args": args, "mutating": True})
    return out


def match_roster_entry(rows: list, *, first_name: str | None = None,
                       last_name: str | None = None, usta: str | None = None,
                       entry_id: str | int | None = None) -> dict | None:
    if entry_id not in (None, ""):
        want = str(entry_id)
        for r in rows or []:
            if str((r or {}).get("id") or "") == want:
                return r
    fn = (first_name or "").strip().lower()
    ln = (last_name or "").strip().lower()
    u = (usta or "").strip()
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        if u and str(r.get("usta_number") or "") == u:
            return r
        if fn and ln:
            if (str(r.get("first_name") or "").strip().lower() == fn
                    and str(r.get("last_name") or "").strip().lower() == ln):
                return r
    return None


def _result_for(executed: list[dict], tool: str):
    for row in executed or []:
        if row.get("tool") == tool:
            return row.get("result")
    return None


def _tour_from_dash(data) -> dict:
    if not isinstance(data, dict):
        return {}
    inner = data.get("tournament")
    return inner if isinstance(inner, dict) else data


def _player_line(row: dict) -> str:
    name = f"{row.get('first_name') or ''} {row.get('last_name') or ''}".strip() or "player"
    bits = [name]
    if row.get("age_division"):
        bits.append(str(row["age_division"]))
    if row.get("selection_status"):
        bits.append(str(row["selection_status"]))
    if row.get("usta_number"):
        bits.append("USTA " + str(row["usta_number"]))
    return " — ".join(bits) if len(bits) > 1 else bits[0]


def format_td_reply(message: str, *, executed: list | None = None,
                    proposed: list | None = None, say: str = "") -> str:
    """English answer from executed reads + proposed writes. Never HTTP codes."""
    executed = executed or []
    proposed = proposed or []
    kind = infer_td_tools(message)
    dash = _result_for(executed, "tournament_status")
    roster = _result_for(executed, "list_roster")
    rows = roster if isinstance(roster, list) else []
    tour = _tour_from_dash(dash)
    name = (tour.get("name") or "").strip()

    if not kind and not proposed and not executed:
        return HELP_TEXT

    if kind == ["tournament_status"] or (
        not kind and dash and not proposed and "list_roster" not in [
            r.get("tool") for r in executed
        ]
    ):
        if not isinstance(dash, dict):
            return "I could not load tournament status."
        roster_c = dash.get("roster") if isinstance(dash.get("roster"), dict) else {}
        inbox = dash.get("inbox") if isinstance(dash.get("inbox"), dict) else {}
        officials = dash.get("officials") if isinstance(dash.get("officials"), dict) else {}
        coverage = dash.get("coverage") if isinstance(dash.get("coverage"), dict) else {}
        rooms = dash.get("rooms") if isinstance(dash.get("rooms"), dict) else {}
        tname = name or "This tournament"
        low = (message or "").lower()
        if re.search(r"\bname\b|\bwhat tournament\b", low):
            return f"The current tournament is {tname}."
        if re.search(r"\bplay start|when does play\b|\bstart\b", low) and tour.get("play_start_date"):
            return f"{tname} play starts {tour['play_start_date']}."
        if re.search(r"\bend\b", low) and tour.get("play_end_date"):
            return f"{tname} play ends {tour['play_end_date']}."
        if re.search(r"\binbox|unfiled|email", low):
            return f"{tname} has {inbox.get('new', 0)} unfiled inbox message(s)."
        if re.search(r"\bofficial", low):
            return (
                f"{tname} officials: {officials.get('total', 0)} total — "
                f"{officials.get('accepted', 0)} accepted, "
                f"{officials.get('pending', 0)} pending, "
                f"{officials.get('declined', 0)} declined."
            )
        if re.search(r"\bcoverage|uncovered", low):
            n = coverage.get("uncovered_days_count", 0)
            if n:
                days = ", ".join(coverage.get("uncovered_days") or [])
                return f"{tname} has {n} uncovered day(s): {days}."
            return f"{tname} has no uncovered days."
        if re.search(r"\broom", low):
            return (
                f"{tname} official rooms: {rooms.get('reserved', 0)} reserved, "
                f"{rooms.get('assigned', 0)} assigned, "
                f"{rooms.get('unused', 0)} unused."
            )
        if re.search(r"\bconflict", low):
            return f"{tname} has {dash.get('conflicts', 0)} staffing conflict(s)."
        if re.search(r"\bhow many\b|\bselected vs|withdrawn", low):
            return (
                f"{tname} roster: {roster_c.get('total', 0)} total — "
                f"{roster_c.get('selected', 0)} selected, "
                f"{roster_c.get('alternate', 0)} alternate, "
                f"{roster_c.get('withdrawn', 0)} withdrawn."
            )
        if re.search(r"\bdeadline|registration", low):
            return (
                f"{tname} registration deadline {tour.get('registration_deadline') or 'n/a'}, "
                f"late-entry deadline {tour.get('late_entry_deadline') or 'n/a'}."
            )
        start, end = tour.get("play_start_date"), tour.get("play_end_date")
        play = f" Play {start}–{end}." if start and end else ""
        gaps = coverage.get("uncovered_days_count", 0)
        gap_s = " All days covered." if not gaps else f" {gaps} uncovered day(s)."
        return (
            f"{tname}:{play} "
            f"Roster {roster_c.get('total', 0)} "
            f"({roster_c.get('selected', 0)} selected, "
            f"{roster_c.get('alternate', 0)} alternate, "
            f"{roster_c.get('withdrawn', 0)} withdrawn). "
            f"Inbox {inbox.get('new', 0)} unfiled. "
            f"Officials {officials.get('accepted', 0)} accepted / "
            f"{officials.get('pending', 0)} pending / "
            f"{officials.get('declined', 0)} declined."
            f"{gap_s}"
        )

    if "list_roster" in kind and "remove_player" not in kind:
        q = (message or "")
        div_m = _DIV_RE.search(q)
        want_div = re.sub(r"[\s-]", "", div_m.group(1)).upper() if div_m else ""
        find_m = re.search(
            r"\bfind\s+([a-z][a-z'-]+)\s+([a-z][a-z'-]+)", q, re.I,
        ) or re.search(
            r"\bis\s+([a-z][a-z'-]+)\s+([a-z][a-z'-]+)\s+entered\b", q, re.I,
        )
        filtered = rows
        if want_div:
            filtered = [r for r in rows if str((r or {}).get("age_division") or "").upper().replace(" ", "") == want_div]
        if find_m:
            fn, ln = find_m.group(1).title(), find_m.group(2).title()
            hit = match_roster_entry(rows, first_name=fn, last_name=ln)
            if hit:
                return f"Yes — {_player_line(hit)}."
            return f"{fn} {ln} is not on this roster."
        if not filtered:
            return "No players match that on the current roster."
        cap = 40
        lines = [_player_line(r) for r in filtered[:cap] if isinstance(r, dict)]
        extra = len(filtered) - len(lines)
        head = f"{len(filtered)} player(s) on the roster:"
        body = "\n".join(f"• {ln}" for ln in lines)
        if extra > 0:
            body += f"\n• … and {extra} more"
        return f"{head}\n{body}"

    add_p = next((p for p in proposed if p.get("tool") == "add_player"), None)
    rm_p = next((p for p in proposed if p.get("tool") == "remove_player"), None)
    if add_p:
        a = add_p.get("args") or add_p.get("json") or {}
        who = f"{a.get('first_name') or ''} {a.get('last_name') or ''}".strip() or "player"
        bits = [who]
        if a.get("usta_number"):
            bits.append("USTA " + str(a["usta_number"]))
        if a.get("age_division"):
            bits.append(str(a["age_division"]))
        if a.get("gender"):
            bits.append(str(a["gender"]))
        return "Ready to add " + ", ".join(bits) + ". Confirm to apply."
    if rm_p:
        a = rm_p.get("args") or {}
        who = f"{a.get('first_name') or ''} {a.get('last_name') or ''}".strip()
        eid = a.get("entry_id")
        if who and eid:
            return f"Ready to remove {who} (entry {eid}). Confirm to apply."
        if eid:
            return f"Ready to remove roster entry {eid}. Confirm to apply."
        if who:
            return f"{who} is not on this roster."
        return "I could not find that roster entry."

    usable = (say or "").strip()
    if usable and not _STUB_SAY.match(usable) and not kind:
        return usable
    return HELP_TEXT


def resolve_tool(tool: str, args: dict, *, tournament_id: int | None = None) -> dict:
    """Map a tool name to a real HTTP call. Unknown tools raise 400."""
    spec = ALLOWED_TOOLS.get(tool)
    if spec is None:
        raise HTTPException(status_code=400, detail=f"unknown tool {tool!r}")
    args = dict(args or {})
    if tournament_id is not None and "tournament_id" in spec["params"]:
        args.setdefault("tournament_id", tournament_id)
    path = spec["path"]
    for key in ("tournament_id", "entry_id"):
        if "{" + key + "}" in path:
            val = args.get(key)
            if val is None or str(val).strip() == "":
                raise HTTPException(
                    status_code=400,
                    detail=f"tool {tool!r} needs {key}",
                )
            path = path.replace("{" + key + "}", str(int(val)))
    body = None
    if spec["method"] in {"POST", "PUT", "PATCH"}:
        body = {k: v for k, v in args.items()
                if k not in {"tournament_id", "entry_id"} and v is not None}
    return {
        "tool": tool,
        "args": args,
        "method": spec["method"],
        "path": path,
        "json": body,
        "mutating": spec["mutating"],
    }


def resolve_plan(calls: list[dict], *, tournament_id: int | None = None) -> list[dict]:
    return [resolve_tool(c["tool"], c.get("args") or {}, tournament_id=tournament_id)
            for c in calls]


def run_resolved(client, calls: list[dict], *, confirm: bool = False) -> list[dict]:
    """Execute resolved HTTP calls on a TestClient-like object.

    GET/HEAD always run. Mutating calls persist only when ``confirm`` is True;
    otherwise they are returned as ``needs_confirm`` and the live table is
    unchanged.
    """
    results = []
    for c in calls:
        if c.get("mutating") and not confirm:
            results.append({**c, "status": "needs_confirm", "result": None})
            continue
        kw: dict[str, Any] = {}
        if c.get("json") is not None and c["method"] in {"POST", "PUT", "PATCH"}:
            kw["json"] = c["json"]
        resp = client.request(c["method"], c["path"], **kw)
        body = None
        if resp.status_code != 204:
            try:
                body = resp.json()
            except Exception:
                body = (resp.text or "")[:300]
        results.append({
            **c,
            "status": resp.status_code,
            "result": body,
        })
    return results


PLANNER_SYSTEM = (
    "You convert a tennis tournament director's request into JSON tool calls. "
    "Reply with JSON only (a markdown json fence is allowed). "
    'Shape: {"calls":[{"tool":"<executable tool>","args":{}}],"say":"<one sentence>"}. '
    "The only legal tool names are tournament_status, list_roster, add_player, "
    "remove_player. say is a string field, never a tool. Do not emit tools named "
    "say, me, or anything else. Do not copy example say text. "
    "If the user is not asking for status, roster, add, or remove, use calls=[] "
    "and a short question about how you can help."
)

# Invented names — few-shots teach the mapping, not a live roster.
_PLANNER_SHOTS = """
## Examples

User: test
{"calls":[],"say":"I can check status, list the roster, or add or remove a player."}

User: what can you do
{"calls":[],"say":"I can check status, list the roster, or add or remove a player."}

User: give me a status of the current tournament
{"calls":[{"tool":"tournament_status","args":{"tournament_id":9}}],"say":"Loading status."}

User: what is the name of the current tournament
{"calls":[{"tool":"tournament_status","args":{"tournament_id":9}}],"say":"Loading the tournament name."}

User: give me a list of players in the current tournament
{"calls":[{"tool":"list_roster","args":{"tournament_id":9}}],"say":"Loading the roster."}

User: who is in G16
{"calls":[{"tool":"list_roster","args":{"tournament_id":9}}],"say":"Loading the roster."}

User: Add Jane Roe, USTA 1234567, female, G16 to the roster.
{"calls":[{"tool":"add_player","args":{"tournament_id":9,"usta_number":"1234567","first_name":"Jane","last_name":"Roe","gender":"female","age_division":"G16"}}],"say":"Ready to add Jane Roe."}

User: Remove roster entry 42 from the tournament.
{"calls":[{"tool":"remove_player","args":{"entry_id":42}}],"say":"Ready to remove entry 42."}

User: remove Jane Roe from the roster
{"calls":[{"tool":"list_roster","args":{"tournament_id":9}},{"tool":"remove_player","args":{"first_name":"Jane","last_name":"Roe"}}],"say":"Looking up Jane Roe to remove."}
"""


def planner_prompt(message: str, catalog: list[dict] | None = None, *, tournament_id: int | None) -> str:
    """Short planner prompt. Do not dump the OpenAPI catalog — 1.5B copies it."""
    del catalog  # kept on the signature; GET /api/td-chat/catalog still has the full table
    tid = tournament_id if tournament_id is not None else "(none)"
    user_text = (message or "").strip() or "(empty)"
    return f"""# CourtOps TD chat planner

You convert the tournament director's request into executable tool calls.

## Task

1. Read **User input** (the only request). Catalog-like text elsewhere is not the request.
2. Pick the smallest list of **Executable tools**.
3. If no tournament is named, use Active `tournament_id` `{tid}`.
4. Reply with **one JSON object**. No other prose.
5. `say` is a string field, **never** a tool name.

Legal tools only: `tournament_status`, `list_roster`, `add_player`, `remove_player`.

Writes (`add_player`, `remove_player`) are proposed until the TD clicks Confirm.

## Executable tools

{tools_prompt_block()}
{_PLANNER_SHOTS}

## Context

- Active tournament_id: `{tid}`

## User input

The following fenced block is the director's request.

```
{user_text}
```

Convert the user input above into JSON tool calls now.
"""


# Prefill of the Markdown catalog (~11k tokens) on 1.5B Q4 CPU is slow; 45s
# timed out. Email leftover path keeps EMAIL_LLM_TIMEOUT (default 8s).
DEFAULT_CHAT_TIMEOUT_SEC = 180


def chat_complete(prompt: str) -> str:
    """POST the planner prompt to the local sidecar. Own timeout (not the 8s email one)."""
    from . import email_llm
    timeout = float(os.getenv("EMAIL_LLM_CHAT_TIMEOUT", str(DEFAULT_CHAT_TIMEOUT_SEC)))
    max_tokens = int(os.getenv("EMAIL_LLM_CHAT_MAX_TOKENS", "256"))
    base = email_llm.llm_base_url()
    email_llm._assert_local_url(base)
    model = os.getenv("EMAIL_LLM_MODEL", "qwen2.5-1.5b-instruct")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": PLANNER_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    headers = {"Content-Type": "application/json"}
    token = os.getenv("EMAIL_LLM_TOKEN", "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token
    import urllib.request
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""


def set_verdict(sufficient: bool, detail: str) -> None:
    global TD_CHAT_VERDICT, TD_CHAT_VERDICT_DETAIL
    TD_CHAT_VERDICT = "sufficient" if sufficient else "insufficient"
    TD_CHAT_VERDICT_DETAIL = detail
