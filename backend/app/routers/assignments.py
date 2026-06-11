"""Assignments (Tournament <-> Official) with per-day roles + pay/mileage.

Pay     = sum of each worked day's rate (the certification_rate in effect for the
          role worked that day, snapshotted as rate_applied) — audit §3.2.
Mileage = clamp((2 * one_way_miles - 50) * 0.65, 0, 100), using the official's
          distance to the assignment's site — audit §3.1 / §3.7. Null when no
          distance is on file (computation blocked, audit S4).
Hotel date mismatch is surfaced as a flag, not a hard block — audit §3.4.
Room-count IS a hard guard — an official can't be put in a full block (audit §3.4).
Pay/mileage/total are snapshotted on every change with the rule version, so a
figure is reproducible later even if rates/distances change — audit §5.3.
"""
import json

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

# The calculation itself is pure and lives in assignment_calc (unit-tested
# directly — plan P2 #8); this router owns the queries + HTTP. The constants
# are re-exported here because writers below (and older imports) use them.
from ..assignment_calc import (  # noqa: F401  (RULE_VERSION used by writers)
    FREE_MILES,
    MILEAGE_CAP,
    MILEAGE_RATE,
    RULE_VERSION,
    compute_summary,
)
from ..bulk_ops import savepoint
from ..db import db_dep
from ..models import (
    AssignmentBulkCreate,
    AssignmentCreate,
    AssignmentDayCreate,
    AssignmentDayStatus,
    CoverageFillCreate,
)

router = APIRouter(tags=["assignments"])


def _rate_for(cur, cert_type, work_date) -> float:
    cur.execute(
        """
        SELECT rate_per_day FROM certification_rate
        WHERE cert_type = %s AND effective_from <= %s
        ORDER BY effective_from DESC LIMIT 1
        """,
        (cert_type, work_date),
    )
    row = cur.fetchone()
    if row is None:
        # No rate was effective ON the work date (work logged before the rate
        # catalog starts). Fall back to the EARLIEST known rate — the one
        # nearest to that early work date — not the latest (which would pay
        # old work at the newest rate; investigation 2026-06-10).
        cur.execute(
            "SELECT rate_per_day FROM certification_rate WHERE cert_type = %s "
            "ORDER BY effective_from ASC LIMIT 1",
            (cert_type,),
        )
        row = cur.fetchone()
    return float(row["rate_per_day"]) if row else 0.0


def _summary(cur, a: dict) -> dict:
    """Build a rich assignment object with days + computed pay/mileage/flags.

    This side owns the QUERIES; the calculation is pure and lives in
    app/assignment_calc.compute_summary (unit-tested directly, plan P2 #8)."""
    cur.execute(
        "SELECT id, work_date, working_as, rate_applied, actual_status FROM assignment_day "
        "WHERE assignment_id = %s ORDER BY work_date",
        (a["id"],),
    )
    days = cur.fetchall()

    cur.execute(
        "SELECT cert_type FROM certification WHERE official_id = %s",
        (a["official_id"],),
    )
    held_certs = {r["cert_type"] for r in cur.fetchall()}

    one_way_miles = None  # the mileage calc input (snapshotted for audit §5.3)
    missing_distance = False
    if a["site_id"] is not None:
        cur.execute(
            "SELECT one_way_miles FROM official_site_distance "
            "WHERE official_id = %s AND site_id = %s",
            (a["official_id"], a["site_id"]),
        )
        dist = cur.fetchone()
        if dist is None:
            missing_distance = True
        else:
            one_way_miles = float(dist["one_way_miles"])

    # Every date this official works in ANOTHER assignment — feeds both the
    # conflict flags and the add-day pre-check. (Within one tournament an
    # official has one assignment with one role per date — UNIQUE(assignment_id,
    # work_date) — so a same-day clash can only be cross-tournament.)
    cur.execute(
        "SELECT ad.work_date, a2.tournament_id AS other_tournament_id, "
        "       t2.name AS other_tournament, COALESCE(s2.code, s2.name) AS other_site, "
        "       a2.site_id AS other_site_id "
        "FROM assignment_day ad "
        "JOIN assignment a2 ON a2.id = ad.assignment_id "
        "JOIN tournament t2 ON t2.id = a2.tournament_id "
        "LEFT JOIN site s2 ON s2.id = a2.site_id "
        "WHERE a2.official_id = %s AND a2.id <> %s "
        "ORDER BY ad.work_date",
        (a["official_id"], a["id"]),
    )
    other_bookings = cur.fetchall()

    cur.execute(
        "SELECT available_date FROM availability "
        "WHERE official_id = %s AND tournament_id = %s",
        (a["official_id"], a["tournament_id"]),
    )
    avail_rows = cur.fetchall()

    return compute_summary(a, days, held_certs, one_way_miles, missing_distance,
                           other_bookings, avail_rows)


_ASG_SELECT = """
SELECT a.id, a.tournament_id, a.official_id, a.site_id, a.room_block_id,
       a.snapshot_at, a.rule_version, a.pay_audit,
       a.response_status, a.responded_at,
       o.first_name, o.last_name, o.dietary_restrictions,
       o.email AS official_email, o.phone AS official_phone,
       t.play_start_date, t.play_end_date, t.name AS tournament_name,
       COALESCE(s.code, s.name) AS site_label,
       h.name AS hotel_name, rb.check_in AS hotel_check_in, rb.check_out AS hotel_check_out
FROM assignment a
JOIN official o ON o.id = a.official_id
JOIN tournament t ON t.id = a.tournament_id
LEFT JOIN site s ON s.id = a.site_id
LEFT JOIN room_block rb ON rb.id = a.room_block_id
LEFT JOIN hotel h ON h.id = rb.hotel_id
"""


def _check_room_capacity(cur, room_block_id, exclude_id=None) -> None:
    """Hard guard: refuse to put an official in a block with no rooms left."""
    if room_block_id is None:
        return
    cur.execute("SELECT room_count FROM room_block WHERE id = %s", (room_block_id,))
    rb = cur.fetchone()
    if rb is None:
        raise HTTPException(status_code=400, detail="room_block_id does not exist")
    if exclude_id is None:
        cur.execute(
            "SELECT count(*) AS n FROM assignment WHERE room_block_id = %s",
            (room_block_id,),
        )
    else:
        cur.execute(
            "SELECT count(*) AS n FROM assignment WHERE room_block_id = %s AND id <> %s",
            (room_block_id, exclude_id),
        )
    if cur.fetchone()["n"] >= rb["room_count"]:
        raise HTTPException(
            status_code=409, detail=f"room block is full ({rb['room_count']} rooms)"
        )


def _persist_snapshot(cur, assignment_id: int) -> dict:
    """Recompute and freeze pay/mileage/total + the full calc AUDIT (inputs +
    rule constants) on the assignment, so the reimbursement is reproducible even
    if the distance/rates change later (audit §5.3)."""
    cur.execute(_ASG_SELECT + " WHERE a.id = %s", (assignment_id,))
    s = _summary(cur, cur.fetchone())
    audit = {
        "rule_version": RULE_VERSION,
        "constants": {"free_miles": FREE_MILES, "mileage_rate": MILEAGE_RATE,
                      "mileage_cap": MILEAGE_CAP},
        "one_way_miles": s["one_way_miles"],
        "days": [{"work_date": d["work_date"], "working_as": d["working_as"],
                  "rate_applied": d["rate_applied"],
                  "actual_status": d.get("actual_status", "planned")} for d in s["days"]],
        "pay": s["pay"], "mileage": s["mileage"], "total": s["total"],
    }
    cur.execute(
        "UPDATE assignment SET snapshot_pay=%s, snapshot_mileage=%s, "
        "snapshot_total=%s, rule_version=%s, pay_audit=%s::jsonb, snapshot_at=now() "
        "WHERE id=%s RETURNING snapshot_at",
        (s["pay"], s["mileage"], s["total"], RULE_VERSION, json.dumps(audit), assignment_id),
    )
    s["rule_version"] = RULE_VERSION
    s["pay_audit"] = audit
    s["snapshot_at"] = cur.fetchone()["snapshot_at"].isoformat()
    return s


def pay_summary(cur, official_id: int) -> dict:
    """Season pay/mileage summary for an official across ALL their tournaments
    (a per-tournament breakdown + totals). Used by the TD endpoint and the
    official's self-service `/api/me/pay-summary`."""
    cur.execute("SELECT first_name, last_name FROM official WHERE id = %s", (official_id,))
    off = cur.fetchone()
    if off is None:
        raise HTTPException(status_code=404, detail="official not found")
    cur.execute(_ASG_SELECT + " WHERE a.official_id = %s ORDER BY t.play_start_date DESC",
                (official_id,))
    rows = [_summary(cur, a) for a in cur.fetchall()]
    tournaments = [{
        "tournament_id": r["tournament_id"], "tournament_name": r["tournament_name"],
        "pay": r["pay"], "mileage": r["mileage"] or 0.0, "total": r["total"],
        "days": len(r["days"]), "response_status": r["response_status"],
    } for r in rows]
    totals = {
        "pay": round(sum(t["pay"] for t in tournaments), 2),
        "mileage": round(sum(t["mileage"] for t in tournaments), 2),
        "total": round(sum(t["total"] for t in tournaments), 2),
        "assignments": len(tournaments),
        "days": sum(t["days"] for t in tournaments),
    }
    return {"official_id": official_id,
            "official_name": f'{off["last_name"]}, {off["first_name"]}',
            "tournaments": tournaments, "totals": totals}


@router.get("/api/officials/{official_id}/pay-summary")
def official_pay_summary(official_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        return pay_summary(cur, official_id)


@router.get("/api/officials/{official_id}/pay-statement")
def official_pay_statement(official_id: int, conn=Depends(db_dep)):
    """Reimbursement-grade pay statement for one official: every assignment with
    its per-day role + rate, the mileage calc (one-way miles → reimbursed), and a
    grand total. Richer than pay-summary (which is per-tournament totals only) —
    this is the day-level breakdown the official/TD needs for reimbursement."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT first_name, last_name, email, phone, city, state "
            "FROM official WHERE id = %s",
            (official_id,),
        )
        off = cur.fetchone()
        if off is None:
            raise HTTPException(status_code=404, detail="official not found")
        cur.execute(_ASG_SELECT + " WHERE a.official_id = %s ORDER BY t.play_start_date",
                    (official_id,))
        summaries = [_summary(cur, a) for a in cur.fetchall()]

    assignments = [{
        "tournament_id": s["tournament_id"], "tournament_name": s["tournament_name"],
        "site_label": s["site_label"],
        "days": [{"work_date": d["work_date"], "working_as": d["working_as"],
                  "rate_applied": d["rate_applied"],
                  "actual_status": d.get("actual_status", "planned")} for d in s["days"]],
        "pay": s["pay"], "mileage": s["mileage"], "one_way_miles": s["one_way_miles"],
        "missing_distance": s["missing_distance"], "total": s["total"],
        "response_status": s["response_status"],
    } for s in summaries]
    totals = {
        "pay": round(sum(a["pay"] for a in assignments), 2),
        "mileage": round(sum(a["mileage"] or 0.0 for a in assignments), 2),
        "total": round(sum(a["total"] for a in assignments), 2),
        "days": sum(len(a["days"]) for a in assignments),
        "assignments": len(assignments),
    }
    return {
        "official": {
            "id": official_id,
            "name": f'{off["last_name"]}, {off["first_name"]}',
            "email": off["email"], "phone": off["phone"],
            "location": ", ".join(x for x in (off["city"], off["state"]) if x),
        },
        "assignments": assignments,
        "totals": totals,
    }


@router.get("/api/officials/{official_id}/overview")
def official_overview(official_id: int, conn=Depends(db_dep)):
    """Official 360 — the top-bar search lands here: core identity, the certs they
    hold, and their season assignments + pay/mileage totals (reuses pay_summary)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, first_name, last_name, city, state FROM official WHERE id = %s",
            (official_id,),
        )
        off = cur.fetchone()
        if off is None:
            raise HTTPException(status_code=404, detail="official not found")
        cur.execute(
            "SELECT cert_type::text AS cert_type FROM certification "
            "WHERE official_id = %s ORDER BY cert_type::text",
            (official_id,),
        )
        certs = [r["cert_type"] for r in cur.fetchall()]
        pay = pay_summary(cur, official_id)
    return {"official": off, "certs": certs, "pay": pay}


@router.get("/api/tournaments/{tournament_id}/assignments")
def list_assignments(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name", (tournament_id,))
        rows = cur.fetchall()
        return [_summary(cur, a) for a in rows]


def hard_conflict_counts(cur, tournament_ids: list[int]) -> dict:
    """Cheap, set-based count of HARD staffing conflicts per tournament — the two
    that block a clean event: cross-tournament double-bookings (an official with
    the same worked date in another assignment) + uncertified worked days (a role
    the official holds no certification for). Used by the dashboard tile + the
    cross-tournament digest. The full categorised breakdown (also availability /
    play-window / hotel warnings) lives in the GET .../conflicts report."""
    if not tournament_ids:
        return {}
    counts = {tid: 0 for tid in tournament_ids}
    cur.execute(
        "SELECT a.tournament_id, count(*) AS n "
        "FROM assignment a JOIN assignment_day ad ON ad.assignment_id = a.id "
        "WHERE a.tournament_id = ANY(%s) AND EXISTS ("
        "  SELECT 1 FROM assignment a2 JOIN assignment_day ad2 ON ad2.assignment_id = a2.id "
        "  WHERE a2.official_id = a.official_id AND a2.id <> a.id AND ad2.work_date = ad.work_date) "
        "GROUP BY a.tournament_id",
        (tournament_ids,),
    )
    for r in cur.fetchall():
        counts[r["tournament_id"]] = counts.get(r["tournament_id"], 0) + r["n"]
    # Uncertified worked day: the official holds no certification for the role
    # worked that day. Matches the conflict report's uncertified_days flag
    # (an official with NO certs on file → every worked day counts).
    cur.execute(
        "SELECT a.tournament_id, count(*) AS n "
        "FROM assignment a JOIN assignment_day ad ON ad.assignment_id = a.id "
        "WHERE a.tournament_id = ANY(%s) "
        "  AND NOT EXISTS (SELECT 1 FROM certification c "
        "                  WHERE c.official_id = a.official_id "
        "                    AND c.cert_type::text = ad.working_as::text) "
        "GROUP BY a.tournament_id",
        (tournament_ids,),
    )
    for r in cur.fetchall():
        counts[r["tournament_id"]] = counts.get(r["tournament_id"], 0) + r["n"]
    return counts


@router.get("/api/tournaments/{tournament_id}/pay-statements")
def tournament_pay_statements(tournament_id: int, conn=Depends(db_dep)):
    """Batch reimbursement: a pay statement per official assigned to THIS
    tournament — each with their worked days (role + rate), the mileage calc, and
    a total — plus a tournament grand total. Feeds the one-click "all statements"
    PDF the TD hands to finance."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, play_start_date, play_end_date FROM tournament WHERE id = %s",
            (tournament_id,),
        )
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name, o.first_name",
                    (tournament_id,))
        summaries = [_summary(cur, a) for a in cur.fetchall()]

    officials = [{
        "assignment_id": s["id"], "official_name": s["official_name"],
        "official_email": s.get("official_email"),
        "days": [{"work_date": d["work_date"], "working_as": d["working_as"],
                  "rate_applied": d["rate_applied"],
                  "actual_status": d.get("actual_status", "planned")} for d in s["days"]],
        "pay": s["pay"], "mileage": s["mileage"], "one_way_miles": s["one_way_miles"],
        "missing_distance": s["missing_distance"], "total": s["total"],
        "response_status": s["response_status"],
    } for s in summaries]
    totals = {
        "pay": round(sum(o["pay"] for o in officials), 2),
        "mileage": round(sum(o["mileage"] or 0.0 for o in officials), 2),
        "total": round(sum(o["total"] for o in officials), 2),
        "days": sum(len(o["days"]) for o in officials),
        "officials": len(officials),
    }
    return {
        "tournament": {"id": t["id"], "name": t["name"],
                       "play_start_date": t["play_start_date"].isoformat(),
                       "play_end_date": t["play_end_date"].isoformat()},
        "officials": officials,
        "totals": totals,
    }


@router.get("/api/tournaments/{tournament_id}/declined")
def declined_assignments(tournament_id: int, conn=Depends(db_dep)):
    """Declined assignments needing re-staffing — the named, actionable list
    behind the dashboard alert (not just a count). Each carries the official, the
    slot they vacated (site + the days/roles they were going to work), and when
    they declined (most-recent first), so the TD knows exactly who to replace."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT a.id, a.responded_at, a.site_id, "
            "       o.first_name, o.last_name, "
            "       COALESCE(s.code, s.name) AS site_label "
            "FROM assignment a "
            "JOIN official o ON o.id = a.official_id "
            "LEFT JOIN site s ON s.id = a.site_id "
            "WHERE a.tournament_id = %s AND a.response_status = 'declined' "
            "ORDER BY a.responded_at DESC NULLS LAST, o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()
        out = []
        for r in rows:
            cur.execute(
                "SELECT work_date, working_as FROM assignment_day "
                "WHERE assignment_id = %s ORDER BY work_date",
                (r["id"],),
            )
            days = [{"work_date": dd["work_date"].isoformat(), "working_as": dd["working_as"]}
                    for dd in cur.fetchall()]
            out.append({
                "assignment_id": r["id"],
                "official_name": f'{r["last_name"]}, {r["first_name"]}',
                "site_id": r["site_id"], "site_label": r["site_label"],
                "responded_at": r["responded_at"].isoformat() if r["responded_at"] else None,
                "days": days, "day_count": len(days),
            })
    return {"tournament_id": tournament_id, "declined": out, "count": len(out)}


@router.get("/api/tournaments/{tournament_id}/conflicts")
def assignment_conflicts(tournament_id: int, conn=Depends(db_dep)):
    """All staffing conflicts for a tournament in one place, so the TD can resolve
    them before the event. Aggregates the per-assignment flags already computed by
    _summary: cross-tournament double-bookings (hard = a different site same day),
    uncertified worked days, days worked outside a declared-available window, days
    outside the play window, and hotel-date mismatches."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name", (tournament_id,))
        summaries = [_summary(cur, a) for a in cur.fetchall()]

    double_bookings, uncertified, outside_avail, out_of_window, hotel_mismatch = [], [], [], [], []
    for s in summaries:
        who = {"assignment_id": s["id"], "official_id": s["official_id"],
               "official_name": s["official_name"]}
        for c in s["conflicts"]:
            double_bookings.append({**who, "work_date": c["work_date"],
                                    "other_tournament_id": c["other_tournament_id"],
                                    "other_tournament": c["other_tournament"],
                                    "other_site": c["other_site"],
                                    "different_site": c["different_site"]})
        for u in s["uncertified_days"]:
            uncertified.append({**who, "work_date": u["work_date"], "working_as": u["working_as"]})
        for d in s["days_outside_availability"]:
            outside_avail.append({**who, "work_date": d})
        if s["work_date_out_of_window"]:
            out_of_window.append({**who})
        if s["hotel_date_mismatch"]:
            hotel_mismatch.append({**who})

    hard = sum(1 for d in double_bookings if d["different_site"])
    counts = {"double_bookings": len(double_bookings), "hard_double_bookings": hard,
              "uncertified": len(uncertified), "outside_availability": len(outside_avail),
              "out_of_window": len(out_of_window), "hotel_mismatch": len(hotel_mismatch)}
    counts["total"] = (len(double_bookings) + len(uncertified) + len(outside_avail)
                       + len(out_of_window) + len(hotel_mismatch))
    return {"tournament_id": tournament_id, "counts": counts,
            "double_bookings": double_bookings, "uncertified": uncertified,
            "outside_availability": outside_avail, "out_of_window": out_of_window,
            "hotel_mismatch": hotel_mismatch}


@router.post("/api/tournaments/{tournament_id}/assignments", status_code=201)
def create_assignment(tournament_id: int, body: AssignmentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            _check_room_capacity(cur, body.room_block_id)
            cur.execute(
                """
                INSERT INTO assignment (tournament_id, official_id, site_id, room_block_id)
                VALUES (%s, %s, %s, %s) RETURNING id
                """,
                (tournament_id, body.official_id, body.site_id, body.room_block_id),
            )
            new_id = cur.fetchone()["id"]
            return _persist_snapshot(cur, new_id)
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="official already assigned to this tournament")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id, site_id, or room_block_id invalid")


@router.post("/api/tournaments/{tournament_id}/assignments/bulk", status_code=201)
def bulk_create_assignments(tournament_id: int, body: AssignmentBulkCreate,
                            conn=Depends(db_dep)):
    """Invite several officials at once — one pending assignment each. Officials
    already on this tournament are skipped (not an error), so the TD can re-run
    the action as the pool grows. Returns the created assignments plus the
    skipped/invalid ids, and the contact list for the new invites (so the UI can
    open a single mailto to everyone who was just invited)."""
    ids = list(dict.fromkeys(body.official_ids))  # de-dupe, preserve order
    if not ids:
        raise HTTPException(status_code=400, detail="official_ids is required")
    created, skipped_existing, invalid = [], [], []
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        _check_room_capacity(cur, body.room_block_id)
        # Which of these officials exist, and which are already assigned here?
        cur.execute("SELECT id FROM official WHERE id = ANY(%s)", (ids,))
        existing_ids = {r["id"] for r in cur.fetchall()}
        cur.execute(
            "SELECT official_id FROM assignment WHERE tournament_id = %s "
            "AND official_id = ANY(%s)",
            (tournament_id, ids),
        )
        already = {r["official_id"] for r in cur.fetchall()}
        for oid in ids:
            if oid not in existing_ids:
                invalid.append(oid)
                continue
            if oid in already:
                skipped_existing.append(oid)
                continue
            # Room capacity is re-checked per insert so a small block can't be
            # over-filled by a single bulk call.
            try:
                _check_room_capacity(cur, body.room_block_id)
            except HTTPException:
                skipped_existing.append(oid)  # no room left → leave for later
                continue
            # Per-official SAVEPOINT (P2 #10): a concurrent invite landing
            # between the `already` pre-check and this INSERT hits the UNIQUE
            # and would otherwise abort the WHOLE batch — skip just that one.
            try:
                with savepoint(cur):
                    cur.execute(
                        "INSERT INTO assignment (tournament_id, official_id, site_id, room_block_id) "
                        "VALUES (%s, %s, %s, %s) RETURNING id",
                        (tournament_id, oid, body.site_id, body.room_block_id),
                    )
                    created.append(_persist_snapshot(cur, cur.fetchone()["id"]))
            except psycopg.errors.UniqueViolation:
                skipped_existing.append(oid)
    return {
        "created": created,
        "created_count": len(created),
        "skipped_existing": skipped_existing,
        "invalid": invalid,
        # Emails of the freshly-invited officials who have one on file — the UI
        # turns this into a single mailto: to "send" the response request.
        "invite_emails": [c["official_email"] for c in created if c.get("official_email")],
    }


def _compose_invite(s: dict, first_name: str) -> dict:
    """Build the {subject, body} of a personalised assignment email from an
    assignment summary. Shared by the single + tournament-batch invite endpoints."""
    from datetime import date as _date

    def _fmt(iso):
        try:
            return _date.fromisoformat(iso).strftime("%a %b %d, %Y")
        except ValueError:
            return iso

    tname = s["tournament_name"] or "the tournament"
    if s["days"]:
        day_lines = "\n".join(
            f"  - {_fmt(d['work_date'])}: {d['working_as'].replace('_', ' ').title()}"
            for d in s["days"])
        dates = sorted(d["work_date"] for d in s["days"])
        when = f"{_fmt(dates[0])}" if len(dates) == 1 else f"{_fmt(dates[0])} – {_fmt(dates[-1])}"
    else:
        day_lines = "  (days to be confirmed)"
        when = "dates TBD"

    site_line = f"\nSite: {s['site_label']}" if s.get("site_label") else ""
    pay_line = f"${s['pay']:.2f}"
    if s["mileage"]:
        pay_line += f" + ${s['mileage']:.2f} mileage = ${s['total']:.2f} total"
    subject = f"Officiating assignment — {tname} ({when})"
    body = (
        f"Dear {first_name},\n\n"
        f"You've been assigned to officiate {tname}. Your schedule:\n\n"
        f"{day_lines}\n{site_line}\n"
        f"Estimated pay: {pay_line}\n\n"
        f"Please confirm (accept or decline) via your CourtOps self-service "
        f'"My assignments" page at your earliest convenience.\n\n'
        f"Thank you,\nTournament Director"
    )
    return {"subject": subject, "body": body}


@router.get("/api/assignments/{assignment_id}/invite-text")
def assignment_invite_text(assignment_id: int, conn=Depends(db_dep)):
    """A ready-to-paste assignment email personalised to this official: their
    specific worked days + roles, the site, and the estimated pay/mileage. Beyond
    the generic bulk mailto — the TD copies it or opens a pre-filled email."""
    with conn.cursor() as cur:
        cur.execute(_ASG_SELECT + " WHERE a.id = %s", (assignment_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="assignment not found")
        s = _summary(cur, row)
        composed = _compose_invite(s, row["first_name"] or "official")
    return {
        "assignment_id": assignment_id,
        "official_name": s["official_name"],
        "official_email": s.get("official_email"),
        **composed,
    }


@router.get("/api/tournaments/{tournament_id}/invite-texts")
def tournament_invite_texts(tournament_id: int, conn=Depends(db_dep)):
    """A personalised invite for every official assigned to this tournament — the
    TD generates them all at once, copies the combined document, or BCCs everyone
    who has an email on file. Each carries the same per-official detail as the
    single invite."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(_ASG_SELECT + " WHERE a.tournament_id = %s ORDER BY o.last_name, o.first_name",
                    (tournament_id,))
        rows = cur.fetchall()
        invites = []
        for row in rows:
            s = _summary(cur, row)
            composed = _compose_invite(s, row["first_name"] or "official")
            invites.append({
                "assignment_id": s["id"], "official_name": s["official_name"],
                "official_email": s.get("official_email"), **composed,
            })
    emails = [i["official_email"] for i in invites if i["official_email"]]
    return {"invites": invites, "count": len(invites), "emails": emails}


@router.put("/api/assignments/{assignment_id}")
def update_assignment(assignment_id: int, body: AssignmentCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            _check_room_capacity(cur, body.room_block_id, exclude_id=assignment_id)
            cur.execute(
                "UPDATE assignment SET official_id=%s, site_id=%s, room_block_id=%s "
                "WHERE id=%s RETURNING id",
                (body.official_id, body.site_id, body.room_block_id, assignment_id),
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            return _persist_snapshot(cur, assignment_id)
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="official already assigned to this tournament")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="official_id, site_id, or room_block_id invalid")


@router.delete("/api/assignments/{assignment_id}", status_code=204)
def delete_assignment(assignment_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM assignment WHERE id = %s", (assignment_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="assignment not found")
    return Response(status_code=204)


def _insert_day(cur, assignment_id: int, official_id: int, work_date, working_as) -> None:
    """Add a worked day to an assignment with the certification guard (audit §3.2)
    + per-day rate snapshot. Raises HTTPException on a cert mismatch / duplicate
    date. Shared by add_day and coverage_fill."""
    # If the official has certifications on file, the worked role must be one of
    # them. If none are recorded, allow (data may be incomplete).
    cur.execute("SELECT count(*) AS n FROM certification WHERE official_id = %s", (official_id,))
    if cur.fetchone()["n"] > 0:
        cur.execute(
            "SELECT 1 FROM certification WHERE official_id = %s AND cert_type = %s",
            (official_id, working_as),
        )
        if cur.fetchone() is None:
            raise HTTPException(
                status_code=409, detail=f"official is not certified as {working_as}",
            )
    rate = _rate_for(cur, working_as, work_date)
    try:
        cur.execute(
            "INSERT INTO assignment_day (assignment_id, work_date, working_as, rate_applied) "
            "VALUES (%s, %s, %s, %s)",
            (assignment_id, work_date, working_as, rate),
        )
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="this work date is already on the assignment")


@router.post("/api/assignments/{assignment_id}/days", status_code=201)
def add_day(assignment_id: int, body: AssignmentDayCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT official_id FROM assignment WHERE id = %s", (assignment_id,))
        asg = cur.fetchone()
        if asg is None:
            raise HTTPException(status_code=404, detail="assignment not found")
        _insert_day(cur, assignment_id, asg["official_id"], body.work_date, body.working_as)
        return _persist_snapshot(cur, assignment_id)


@router.put("/api/assignment-days/{day_id}/status")
def set_day_status(day_id: int, body: AssignmentDayStatus, conn=Depends(db_dep)):
    """Day-of truth (P4-1): record what actually happened on one worked day.
    no_show days drop out of pay, so the snapshot is refrozen; the response is
    the fresh assignment summary the card re-renders from."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE assignment_day SET actual_status = %s WHERE id = %s "
            "RETURNING assignment_id",
            (body.actual_status, day_id),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="assignment day not found")
        return _persist_snapshot(cur, row["assignment_id"])


@router.delete("/api/assignment-days/{day_id}", status_code=204)
def delete_day(day_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT assignment_id FROM assignment_day WHERE id = %s", (day_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="assignment day not found")
        assignment_id = row["assignment_id"]
        cur.execute("DELETE FROM assignment_day WHERE id = %s", (day_id,))
        _persist_snapshot(cur, assignment_id)
    return Response(status_code=204)


@router.get("/api/tournaments/{tournament_id}/coverage-candidates")
def coverage_candidates(tournament_id: int, role: str, date: str, conn=Depends(db_dep)):
    """Who could fill an uncovered (role, date) cell on the coverage report —
    officials CERTIFIED for `role` who aren't already working `date` in this
    tournament. Each carries flags so the UI can rank them: `available` (declared
    available that day), `assigned_here` (already on this tournament — fill just
    adds a day, no new invite), and `busy_elsewhere` (working that date in another
    tournament — a soft double-book warning). Best candidates sort first."""
    from datetime import date as _date
    try:
        _date.fromisoformat(date)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="date must be ISO format (YYYY-MM-DD)")
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.id, o.last_name, o.first_name,
                   EXISTS (SELECT 1 FROM assignment a
                           WHERE a.tournament_id = %(tid)s AND a.official_id = o.id)
                       AS assigned_here,
                   EXISTS (SELECT 1 FROM availability av
                           WHERE av.official_id = o.id AND av.tournament_id = %(tid)s
                             AND av.available_date = %(d)s) AS available,
                   EXISTS (SELECT 1 FROM assignment a
                           JOIN assignment_day ad ON ad.assignment_id = a.id
                           WHERE a.official_id = o.id AND ad.work_date = %(d)s
                             AND a.tournament_id <> %(tid)s) AS busy_elsewhere
            FROM official o
            JOIN certification c
              ON c.official_id = o.id AND c.cert_type::text = %(role)s
            WHERE NOT EXISTS (
                SELECT 1 FROM assignment a
                JOIN assignment_day ad ON ad.assignment_id = a.id
                WHERE a.tournament_id = %(tid)s AND a.official_id = o.id
                  AND ad.work_date = %(d)s
            )
            ORDER BY available DESC, busy_elsewhere ASC, o.last_name, o.first_name
            """,
            {"tid": tournament_id, "role": role, "d": date},
        )
        rows = cur.fetchall()
    return [
        {"official_id": r["id"], "official_name": f'{r["last_name"]}, {r["first_name"]}',
         "available": r["available"], "assigned_here": r["assigned_here"],
         "busy_elsewhere": r["busy_elsewhere"]}
        for r in rows
    ]


@router.post("/api/tournaments/{tournament_id}/coverage-fill", status_code=201)
def coverage_fill(tournament_id: int, body: CoverageFillCreate, conn=Depends(db_dep)):
    """Fill a coverage gap in one click: ensure the official has an assignment on
    this tournament (create a pending one if needed), then add the (date, role)
    day. Reuses the cert guard + pay snapshot. 409 if they already work that day."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM assignment WHERE tournament_id = %s AND official_id = %s",
                (tournament_id, body.official_id),
            )
            row = cur.fetchone()
            if row is not None:
                aid = row["id"]
            else:
                cur.execute(
                    "INSERT INTO assignment (tournament_id, official_id) VALUES (%s, %s) RETURNING id",
                    (tournament_id, body.official_id),
                )
                aid = cur.fetchone()["id"]
            _insert_day(cur, aid, body.official_id, body.work_date, body.working_as)
            return _persist_snapshot(cur, aid)
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="tournament_id or official_id invalid")
