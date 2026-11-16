"""TD chat: plan allowlisted API calls via the local llama.cpp sidecar."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import td_chat
from ..db import db_dep
from ..email_llm import llm_enabled, probe_llm
from ..security import require_admin

router = APIRouter(prefix="/api/td-chat", tags=["td-chat"])


class ChatTurnIn(BaseModel):
    message: str
    tournament_id: int | None = None


class ChatExecuteIn(BaseModel):
    calls: list[dict]
    confirm: bool = False
    tournament_id: int | None = None
    # AUTHZ-10: token minted for these exact calls by /turn (or a prior
    # confirm=false execute). Required when confirm=true and the calls mutate.
    confirm_token: str | None = None


@router.get("/catalog")
def catalog():
    from ..main import app
    return td_chat.build_catalog(app)


@router.get("/verdict")
def verdict():
    return {
        "model": "qwen2.5-1.5b-instruct-q4_k_m",
        "verdict": td_chat.TD_CHAT_VERDICT,
        "detail": td_chat.TD_CHAT_VERDICT_DETAIL,
        "sidecar": probe_llm(),
    }


@router.post("/turn")
def chat_turn(body: ChatTurnIn, user=Depends(require_admin), conn=Depends(db_dep)):
    from ..main import app
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    cat = td_chat.build_catalog(app)
    prompt = td_chat.planner_prompt(message, cat, tournament_id=body.tournament_id)
    raw = ""
    llm = probe_llm()
    if llm_enabled() and llm == "ok":
        try:
            raw = td_chat.chat_complete(prompt)
        except Exception as e:
            raw = ""
            plan = {"calls": [], "say": f"sidecar error: {type(e).__name__}"}
            return {
                "reply": plan["say"],
                "raw": "",
                "proposed": [],
                "executed": [],
                "llm": llm,
                "needs_confirm": False,
                "verdict": td_chat.TD_CHAT_VERDICT,
            }
    plan = td_chat.parse_plan(raw) if raw else {"calls": [], "say": ""}
    if not raw and llm != "ok":
        plan["say"] = (
            "Local Intelligence is off or down — start it with "
            "scripts/run_local.ps1, or use the roster form."
        )
    calls = td_chat.plan_calls(message, plan.get("calls"))
    if any(c["tool"] == "remove_player" for c in calls) and not any(
        c["tool"] == "list_roster" for c in calls
    ):
        rm = next(c for c in calls if c["tool"] == "remove_player")
        if not (rm.get("args") or {}).get("entry_id"):
            calls = [{"tool": "list_roster", "args": {}}] + calls
    resolved = []
    soft_removes = []
    for c in calls:
        if c["tool"] == "remove_player" and not (c.get("args") or {}).get("entry_id"):
            soft_removes.append({
                "tool": "remove_player", "args": dict(c.get("args") or {}),
                "mutating": True,
            })
            continue
        try:
            resolved.append(td_chat.resolve_tool(
                c["tool"], c.get("args") or {}, tournament_id=body.tournament_id,
            ))
        except HTTPException:
            continue
    reads = [p for p in resolved if not p.get("mutating")]
    writes = [p for p in resolved if p.get("mutating")]
    executed = _run_handlers(conn, reads, confirm=False, user=user) if reads else []
    roster_rows = []
    for row in executed:
        if row.get("tool") == "list_roster" and isinstance(row.get("result"), list):
            roster_rows = row["result"]
    for s in td_chat.attach_remove_matches(soft_removes, roster_rows):
        args = s.get("args") or {}
        if args.get("entry_id"):
            try:
                writes.append(td_chat.resolve_tool(
                    "remove_player", args, tournament_id=body.tournament_id,
                ))
                continue
            except HTTPException:
                pass
        writes.append(s)
    reply = td_chat.format_td_reply(
        message, executed=executed, proposed=writes, say=plan.get("say") or "",
    )
    if not raw and llm != "ok" and not executed and not writes:
        reply = plan["say"]
    needs_confirm = any(
        w.get("tool") == "add_player"
        or (w.get("tool") == "remove_player" and (w.get("args") or {}).get("entry_id"))
        for w in writes
    )
    out = {
        "reply": reply,
        "raw": raw[:2000],
        "proposed": writes,
        "unknown_tools": [],
        "executed": executed,
        "llm": llm,
        "needs_confirm": needs_confirm,
        "verdict": td_chat.TD_CHAT_VERDICT,
    }
    if writes:
        # AUTHZ-10: mint the approval token here, where the server decided the
        # plan. The UI echoes it back with the same calls when the TD confirms.
        from .. import confirm_plans

        out["confirm_token"] = confirm_plans.mint(
            user["username"], body.tournament_id,
            [{"tool": w.get("tool"), "args": w.get("args") or {}} for w in writes],
        )
    return out


@router.post("/execute")
def chat_execute(body: ChatExecuteIn, request: Request,
                 user=Depends(require_admin), conn=Depends(db_dep)):
    """Re-resolve every call on the server (ignore client method/path/mutating)."""
    del request
    resolved = []
    for c in body.calls or []:
        tool = (c.get("tool") or "").strip()
        if not tool:
            raise HTTPException(status_code=400, detail="each call needs tool")
        args = c.get("args") if isinstance(c.get("args"), dict) else {}
        resolved.append(td_chat.resolve_tool(
            tool, args, tournament_id=body.tournament_id,
        ))
    mutating = [c for c in resolved if c.get("mutating")]
    if mutating and body.confirm:
        # AUTHZ-10: the approval must be a server-side record minted for these
        # exact calls by this user, not a boolean the caller asserts.
        from .. import confirm_plans

        if not confirm_plans.consume(
            body.confirm_token, user["username"], body.tournament_id, body.calls
        ):
            raise HTTPException(
                status_code=409,
                detail="plan not confirmed — request it first (confirm=false), then send "
                       "the returned confirm_token with the same calls",
            )
    executed = _run_handlers(conn, resolved, confirm=body.confirm,
                             user=user, tournament_id=body.tournament_id)
    out = {"executed": executed, "applied": bool(body.confirm or not mutating)}
    if mutating and not body.confirm:
        from .. import confirm_plans

        out["confirm_token"] = confirm_plans.mint(
            user["username"], body.tournament_id, body.calls
        )
    return out


def _summarize_result(row: dict) -> str:
    tool = row.get("tool") or ""
    data = row.get("result")
    if not isinstance(data, dict):
        return f"{tool}: {row.get('status')}"
    if tool == "tournament_status":
        roster = data.get("roster") or {}
        inbox = data.get("inbox") or {}
        name = (data.get("name") or "tournament")
        return (
            f"{name}: roster {roster.get('total', 0)} "
            f"(selected {roster.get('selected', 0)}), "
            f"unfiled inbox {inbox.get('new', 0)}."
        )
    if tool == "list_roster" or isinstance(data, list):
        return f"{tool}: {len(data) if isinstance(data, list) else '?'} row(s)."
    return f"{tool}: ok"


def _run_handlers(conn, resolved: list[dict], *, confirm: bool, user: dict,
                  tournament_id: int | None = None) -> list[dict]:
    from fastapi import Response as _Resp

    from .._models_workspace import RosterEntryCreate
    from .dashboard import dashboard
    from .roster import add_roster_entry, delete_roster_entry, list_roster

    out = []
    for c in resolved:
        if c.get("mutating") and not confirm:
            out.append({**c, "status": "needs_confirm", "result": None})
            continue
        method, path = c["method"], c["path"]
        try:
            if method == "GET" and path.endswith("/dashboard"):
                tid = int(path.split("/")[3])
                payload = dashboard(tid, conn)
                out.append({**c, "status": 200, "result": payload})
            elif method == "GET" and path.rstrip("/").endswith("/players"):
                tid = int(path.split("/")[3])
                payload = list_roster(tid, _Resp(), q=None, limit=None, offset=0,
                                      user=user, conn=conn)
                out.append({**c, "status": 200, "result": payload})
            elif method == "POST" and path.rstrip("/").endswith("/players"):
                tid = int(path.split("/")[3])
                body = RosterEntryCreate(**(c.get("json") or {}))
                payload = add_roster_entry(tid, body, conn)
                out.append({**c, "status": 201, "result": payload})
            elif method == "DELETE" and path.startswith("/api/roster/"):
                eid = int(path.rsplit("/", 1)[-1])
                # AUTHZ-10: the plan must act inside the tournament the caller
                # named. A missing tournament_id must not skip the check.
                if tournament_id is None:
                    raise HTTPException(
                        status_code=400,
                        detail="tournament_id is required to execute a plan",
                    )
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT tournament_id FROM tournament_entry WHERE id = %s",
                        (eid,),
                    )
                    entry = cur.fetchone()
                if entry is None or entry["tournament_id"] != tournament_id:
                    raise HTTPException(status_code=404,
                                        detail="roster entry not found in this tournament")
                delete_roster_entry(eid, conn)
                out.append({**c, "status": 204, "result": None})
            else:
                raise HTTPException(status_code=400, detail=f"no handler for {method} {path}")
        except HTTPException as e:
            out.append({**c, "status": e.status_code, "result": {"detail": e.detail}})
    return out
