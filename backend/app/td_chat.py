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


def compact_catalog(catalog: list[dict], limit: int = 80) -> str:
    """One-line-per-route dump for the model (not the full schema)."""
    lines = []
    for row in catalog[:limit]:
        lines.append(f"{row['method']} {row['path']} — {row.get('purpose') or ''}")
    if len(catalog) > limit:
        lines.append(f"… {len(catalog) - limit} more routes; GET /api/td-chat/catalog for all")
    return "\n".join(lines)


def tools_prompt_block() -> str:
    lines = []
    for name, spec in ALLOWED_TOOLS.items():
        lines.append(
            f"- {name}: {spec['method']} {spec['path']} ({spec['purpose']}) "
            f"args={','.join(spec['params'])}"
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


def planner_prompt(message: str, catalog: list[dict], *, tournament_id: int | None) -> str:
    tid = tournament_id if tournament_id is not None else "(none)"
    return (
        "You plan CourtOps API calls for a tennis tournament director.\n"
        "Reply with JSON only, no markdown:\n"
        '{"calls":[{"tool":"tournament_status","args":{"tournament_id":1}}],'
        '"say":"short status"}\n'
        "Allowed tools:\n"
        + tools_prompt_block()
        + "\nAPI catalog (method path — purpose):\n"
        + compact_catalog(catalog)
        + f"\nActive tournament_id: {tid}\n"
        f"User: {message.strip()}\n"
    )


def chat_complete(prompt: str) -> str:
    """POST the planner prompt to the local sidecar. Own timeout (not the 8s email one)."""
    from . import email_llm
    timeout = float(os.getenv("EMAIL_LLM_CHAT_TIMEOUT", os.getenv("EMAIL_LLM_TIMEOUT", "45")))
    max_tokens = int(os.getenv("EMAIL_LLM_CHAT_MAX_TOKENS", "256"))
    base = email_llm.llm_base_url()
    email_llm._assert_local_url(base)
    model = os.getenv("EMAIL_LLM_MODEL", "qwen2.5-1.5b-instruct")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "JSON only. Plan API tool calls."},
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
