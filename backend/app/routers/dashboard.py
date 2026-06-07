"""TD "Today" dashboard — a lightweight at-a-glance aggregate for one tournament.

Rolls up the numbers that otherwise live behind the Inbox, Assignments, Roster
and Reports tabs (unfiled emails, official responses, coverage gaps, roster
status, room pickup) into a single cheap call, so the TD opens the app to a
status board instead of an empty catalog. Uses COUNT/GROUP-BY queries — it does
NOT build the full per-official report.
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from .assignments import hard_conflict_counts

router = APIRouter(tags=["dashboard"])


@router.get("/api/dashboard/deadlines")
def upcoming_deadlines(within_days: int = 14, conn=Depends(db_dep)):
    """Approaching / just-passed key dates across all not-yet-finished
    tournaments, so the TD sees what's due soon without opening each one.
    Covers the registration + late-entry deadlines and the play-start date,
    sorted by date. `days_until` is negative for an overdue date."""
    within_days = max(1, min(within_days, 120))
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, play_start_date, registration_deadline, late_entry_deadline "
            "FROM tournament WHERE play_end_date >= CURRENT_DATE "
            "ORDER BY play_start_date"
        )
        rows = cur.fetchall()
    today = date.today()
    items = []
    for t in rows:
        for kind, dval in (("registration", t["registration_deadline"]),
                           ("late_entry", t["late_entry_deadline"]),
                           ("play_start", t["play_start_date"])):
            if dval is None:
                continue
            n = (dval - today).days
            # upcoming within the window, plus a few days of "just passed" so a
            # missed deadline doesn't vanish the moment it lapses.
            if -3 <= n <= within_days:
                items.append({"tournament_id": t["id"], "tournament_name": t["name"],
                              "kind": kind, "date": dval.isoformat(), "days_until": n})
    items.sort(key=lambda x: (x["date"], x["kind"]))
    return {"deadlines": items, "within_days": within_days}


@router.get("/api/dashboard/digest")
def digest(conn=Depends(db_dep)):
    """Cross-tournament digest: one row per not-yet-finished tournament with its
    soonest key date and a tally of open tasks (unfiled inbox, pending/declined
    officials, uncovered play-window days, incomplete roster entries) — so the TD
    sees everything that needs attention across every active event in one place.
    Set-based aggregates (one query per category), not per-tournament loops."""
    today = date.today()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, play_start_date, play_end_date, "
            "       registration_deadline, late_entry_deadline "
            "FROM tournament WHERE play_end_date >= CURRENT_DATE ORDER BY play_start_date"
        )
        tours = cur.fetchall()
        ids = [t["id"] for t in tours]
        unfiled, pending, declined, worked_days, incomplete = {}, {}, {}, {}, {}
        if ids:
            cur.execute(
                "SELECT tournament_id, count(*) AS n FROM email_message "
                "WHERE tournament_id = ANY(%s) AND status = 'new' GROUP BY tournament_id",
                (ids,),
            )
            unfiled = {r["tournament_id"]: r["n"] for r in cur.fetchall()}

            cur.execute(
                "SELECT tournament_id, response_status, count(*) AS n FROM assignment "
                "WHERE tournament_id = ANY(%s) GROUP BY tournament_id, response_status",
                (ids,),
            )
            for r in cur.fetchall():
                if r["response_status"] == "pending":
                    pending[r["tournament_id"]] = r["n"]
                elif r["response_status"] == "declined":
                    declined[r["tournament_id"]] = r["n"]

            cur.execute(
                "SELECT a.tournament_id, count(DISTINCT ad.work_date) AS n "
                "FROM assignment a JOIN assignment_day ad ON ad.assignment_id = a.id "
                "JOIN tournament t ON t.id = a.tournament_id "
                "WHERE a.tournament_id = ANY(%s) "
                "  AND ad.work_date BETWEEN t.play_start_date AND t.play_end_date "
                "GROUP BY a.tournament_id",
                (ids,),
            )
            worked_days = {r["tournament_id"]: r["n"] for r in cur.fetchall()}

            cur.execute(
                "SELECT e.tournament_id, count(*) AS n FROM tournament_entry e "
                "JOIN player p ON p.id = e.player_id "
                "WHERE e.tournament_id = ANY(%s) "
                "  AND e.selection_status IN ('selected','alternate') "
                "  AND (e.age_division IS NULL OR e.age_division = '' OR p.gender IS NULL "
                "       OR e.t_shirt_size IS NULL OR e.t_shirt_size = '' "
                "       OR (e.amount_outstanding IS NOT NULL AND e.amount_outstanding > 0)) "
                "GROUP BY e.tournament_id",
                (ids,),
            )
            incomplete = {r["tournament_id"]: r["n"] for r in cur.fetchall()}
            conflicts = hard_conflict_counts(cur, ids)
        else:
            conflicts = {}

    def _next_deadline(t):
        cands = []
        for kind, dval in (("registration", t["registration_deadline"]),
                           ("late_entry", t["late_entry_deadline"]),
                           ("play_start", t["play_start_date"])):
            if dval is None:
                continue
            n = (dval - today).days
            if n >= -3:  # upcoming, or just-passed grace
                cands.append({"kind": kind, "date": dval.isoformat(), "days_until": n})
        cands.sort(key=lambda x: x["days_until"])
        return cands[0] if cands else None

    out = []
    for t in tours:
        tid = t["id"]
        window_len = (t["play_end_date"] - t["play_start_date"]).days + 1
        uncovered = max(window_len - worked_days.get(tid, 0), 0)
        tasks = {
            "unfiled_inbox": unfiled.get(tid, 0),
            "officials_pending": pending.get(tid, 0),
            "officials_declined": declined.get(tid, 0),
            "uncovered_days": uncovered,
            "roster_incomplete": incomplete.get(tid, 0),
            "conflicts": conflicts.get(tid, 0),
        }
        out.append({
            "tournament_id": tid, "tournament_name": t["name"],
            "play_start_date": t["play_start_date"].isoformat(),
            "play_end_date": t["play_end_date"].isoformat(),
            "next_deadline": _next_deadline(t),
            "tasks": tasks,
            "open_tasks": sum(tasks.values()),
        })
    # Most urgent first: soonest upcoming key date, then events with the most
    # open work, then play-start order.
    def _urgency(row):
        nd = row["next_deadline"]
        return (nd["days_until"] if nd else 9999, -row["open_tasks"], row["play_start_date"])
    out.sort(key=_urgency)

    totals = {k: sum(r["tasks"][k] for r in out) for k in
              ("unfiled_inbox", "officials_pending", "officials_declined",
               "uncovered_days", "roster_incomplete", "conflicts")}
    totals["open_tasks"] = sum(r["open_tasks"] for r in out)
    totals["active_tournaments"] = len(out)
    return {"tournaments": out, "totals": totals}


@router.get("/api/tournaments/{tournament_id}/dashboard")
def dashboard(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, type, play_start_date, play_end_date, "
            "       registration_deadline, late_entry_deadline "
            "FROM tournament WHERE id = %s",
            (tournament_id,),
        )
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        start, end = t["play_start_date"], t["play_end_date"]
        t["play_start_date"] = start.isoformat()
        t["play_end_date"] = end.isoformat()
        for k in ("registration_deadline", "late_entry_deadline"):
            t[k] = t[k].isoformat() if t[k] else None

        # Inbox: how many emails are still unfiled (new) vs filed / follow-up.
        cur.execute(
            "SELECT status, count(*) AS n FROM email_message WHERE tournament_id = %s GROUP BY status",
            (tournament_id,),
        )
        ib = {r["status"]: r["n"] for r in cur.fetchall()}
        inbox = {"new": ib.get("new", 0), "filed": ib.get("filed", 0),
                 "needs_followup": ib.get("needs_followup", 0)}

        # Roster status mix.
        cur.execute(
            "SELECT selection_status, count(*) AS n FROM tournament_entry "
            "WHERE tournament_id = %s GROUP BY selection_status",
            (tournament_id,),
        )
        rs = {r["selection_status"]: r["n"] for r in cur.fetchall()}
        roster = {"selected": rs.get("selected", 0), "alternate": rs.get("alternate", 0),
                  "withdrawn": rs.get("withdrawn", 0),
                  "total": sum(rs.values())}

        # Officials: assignment response mix (accept/decline/pending).
        cur.execute(
            "SELECT response_status, count(*) AS n FROM assignment "
            "WHERE tournament_id = %s GROUP BY response_status",
            (tournament_id,),
        )
        os_ = {r["response_status"]: r["n"] for r in cur.fetchall()}
        officials = {"total": sum(os_.values()), "pending": os_.get("pending", 0),
                     "accepted": os_.get("accepted", 0), "declined": os_.get("declined", 0)}

        # Coverage gaps: play-window days with no official assigned at all.
        cur.execute(
            "SELECT DISTINCT ad.work_date FROM assignment_day ad "
            "JOIN assignment a ON a.id = ad.assignment_id WHERE a.tournament_id = %s",
            (tournament_id,),
        )
        worked = {r["work_date"] for r in cur.fetchall()}
        uncovered, cur_day = [], start
        while cur_day <= end:
            if cur_day not in worked:
                uncovered.append(cur_day.isoformat())
            cur_day += timedelta(days=1)

        # Official room-block pickup: reserved vs assigned (declined frees a room).
        cur.execute(
            "SELECT COALESCE(sum(rb.room_count), 0) AS reserved, "
            "       COALESCE(sum((SELECT count(*) FROM assignment a "
            "                     WHERE a.room_block_id = rb.id "
            "                     AND a.response_status <> 'declined')), 0) AS assigned "
            "FROM room_block rb WHERE rb.tournament_id = %s AND rb.kind = 'official'",
            (tournament_id,),
        )
        rb = cur.fetchone()
        reserved, assigned = int(rb["reserved"]), int(rb["assigned"])

        # Hard staffing conflicts (double-bookings + uncertified days) — the same
        # cheap count the cross-tournament digest uses; full breakdown on Reports.
        conflicts = hard_conflict_counts(cur, [tournament_id]).get(tournament_id, 0)

    return {
        "tournament": t,
        "inbox": inbox,
        "roster": roster,
        "officials": officials,
        "coverage": {"uncovered_days": uncovered, "uncovered_days_count": len(uncovered)},
        "rooms": {"reserved": reserved, "assigned": assigned,
                  "unused": max(reserved - assigned, 0)},
        "conflicts": conflicts,
    }


@router.get("/api/tournaments/{tournament_id}/readiness")
def readiness(tournament_id: int, conn=Depends(db_dep)):
    """Pre-tournament "are we ready?" scorecard. Rolls the dashboard signals into
    one pass/warn/fail check per area so the TD sees blockers at a glance.
    `fail` = a hard blocker (uncovered day, double-booking, declined slot to
    re-staff); `warn` = should-resolve (pending replies, incomplete roster,
    unused rooms, unfiled mail). `ready` is true when there are no fails."""
    dash = dashboard(tournament_id, conn)  # reuses every aggregate (+ 404 guard)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) AS n FROM tournament_entry e JOIN player p ON p.id = e.player_id "
            "WHERE e.tournament_id = %s AND e.selection_status IN ('selected','alternate') "
            "  AND (e.age_division IS NULL OR e.age_division = '' OR p.gender IS NULL "
            "       OR e.t_shirt_size IS NULL OR e.t_shirt_size = '' "
            "       OR (e.amount_outstanding IS NOT NULL AND e.amount_outstanding > 0))",
            (tournament_id,),
        )
        roster_incomplete = cur.fetchone()["n"]

    cov = dash["coverage"]["uncovered_days_count"]
    off = dash["officials"]
    unused = dash["rooms"]["unused"]
    new_mail = dash["inbox"]["new"]
    conflicts = dash["conflicts"]

    def chk(key, label, value, fail_if, warn_if, ok_text, bad_text):
        status = "fail" if fail_if else ("warn" if warn_if else "pass")
        return {"key": key, "label": label, "value": value, "status": status,
                "detail": (ok_text if status == "pass" else bad_text)}

    checks = [
        chk("coverage", "Day coverage", cov, cov > 0, False,
            "every play day has an official", f"{cov} day(s) with no official"),
        chk("conflicts", "Staffing conflicts", conflicts, conflicts > 0, False,
            "no double-bookings or uncertified days", f"{conflicts} staffing conflict(s)"),
        chk("declined", "Declined assignments", off["declined"], off["declined"] > 0, False,
            "no declined assignments to re-staff", f"{off['declined']} declined — needs re-staffing"),
        chk("responses", "Official responses", off["pending"], False, off["pending"] > 0,
            "all officials have responded", f"{off['pending']} awaiting accept/decline"),
        chk("roster", "Roster completeness", roster_incomplete, False, roster_incomplete > 0,
            "every active entry is complete", f"{roster_incomplete} incomplete entr(y/ies)"),
        chk("rooms", "Room pickup", unused, False, unused > 0,
            "no unused reserved rooms", f"{unused} reserved room(s) unused — release before cutoff"),
        chk("inbox", "Inbox", new_mail, False, new_mail > 0,
            "inbox is clear", f"{new_mail} unfiled email(s)"),
    ]
    summary = {"pass": sum(1 for c in checks if c["status"] == "pass"),
               "warn": sum(1 for c in checks if c["status"] == "warn"),
               "fail": sum(1 for c in checks if c["status"] == "fail")}
    return {"tournament": dash["tournament"], "checks": checks,
            "ready": summary["fail"] == 0, "summary": summary}
