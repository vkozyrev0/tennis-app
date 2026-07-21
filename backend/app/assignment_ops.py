"""Shared assignment query/calc helpers (C2 split from routers/assignments.py).

Used by the assignments router, assignments_bulk, me, payroll, reports, and
dashboard. No FastAPI routes here — only cursor-level helpers + SELECT shape.
"""
import json
from collections import defaultdict

from fastapi import HTTPException

import psycopg

from .assignment_calc import (
    FREE_MILES,
    MILEAGE_CAP,
    MILEAGE_RATE,
    RULE_VERSION,
    compute_summary,
)

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

def _summaries(cur, assignments) -> list[dict]:
    """Batch equivalent of ``[_summary(cur, a) for a in assignments]`` — loads
    every per-assignment input in **5 set-based queries** instead of 5 PER
    assignment (the N+1 fan-out that dominated the payroll / officials-report /
    pay-statement / conflict endpoints — perf audit 2026-06-24). The pure
    ``compute_summary()`` is unchanged; only the data-loading layer is batched."""
    assignments = list(assignments)
    if not assignments:
        return []
    aids = [a["id"] for a in assignments]
    oids = list({a["official_id"] for a in assignments})

    # 1) assignment_day rows, grouped by assignment. Pop the grouping key so each
    #    per-day dict matches the single-query shape compute_summary copies out.
    cur.execute(
        "SELECT assignment_id, id, work_date, working_as, rate_applied, actual_status "
        "FROM assignment_day WHERE assignment_id = ANY(%s) ORDER BY assignment_id, work_date",
        (aids,),
    )
    days_by: dict = defaultdict(list)
    for r in cur.fetchall():
        days_by[r.pop("assignment_id")].append(r)

    # 2) certifications, grouped by official.
    cur.execute("SELECT official_id, cert_type FROM certification WHERE official_id = ANY(%s)", (oids,))
    certs_by: dict = defaultdict(set)
    for r in cur.fetchall():
        certs_by[r["official_id"]].add(r["cert_type"])

    # 3) site distances for the (official, site) pairs in play.
    dist_by: dict = {}
    if any(a["site_id"] is not None for a in assignments):
        cur.execute("SELECT official_id, site_id, one_way_miles FROM official_site_distance "
                    "WHERE official_id = ANY(%s)", (oids,))
        for r in cur.fetchall():
            dist_by[(r["official_id"], r["site_id"])] = float(r["one_way_miles"])

    # 4) every day these officials work in ANY assignment; per-assignment we drop
    #    the current one to get "other bookings" (matches WHERE a2.id <> %s).
    cur.execute(
        "SELECT a2.official_id, a2.id AS assignment_id, ad.work_date, "
        "       a2.tournament_id AS other_tournament_id, t2.name AS other_tournament, "
        "       COALESCE(s2.code, s2.name) AS other_site, a2.site_id AS other_site_id "
        "FROM assignment_day ad "
        "JOIN assignment a2 ON a2.id = ad.assignment_id "
        "JOIN tournament t2 ON t2.id = a2.tournament_id "
        "LEFT JOIN site s2 ON s2.id = a2.site_id "
        "WHERE a2.official_id = ANY(%s) ORDER BY a2.official_id, ad.work_date",
        (oids,),
    )
    bookings_by: dict = defaultdict(list)
    for r in cur.fetchall():
        bookings_by[r["official_id"]].append(r)

    # 5) availability, keyed by (official, tournament).
    cur.execute("SELECT official_id, tournament_id, available_date FROM availability "
                "WHERE official_id = ANY(%s)", (oids,))
    avail_by: dict = defaultdict(list)
    for r in cur.fetchall():
        avail_by[(r["official_id"], r["tournament_id"])].append(r)

    out = []
    for a in assignments:
        oid, sid = a["official_id"], a["site_id"]
        one_way, missing = None, False
        if sid is not None:
            d = dist_by.get((oid, sid))
            if d is None:
                missing = True
            else:
                one_way = d
        other = [b for b in bookings_by.get(oid, []) if b["assignment_id"] != a["id"]]
        out.append(compute_summary(
            a, days_by.get(a["id"], []), certs_by.get(oid, set()),
            one_way, missing, other, avail_by.get((oid, a["tournament_id"]), []),
        ))
    return out


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

def _check_assignment_refs(cur, tournament_id: int, site_id, room_block_id) -> None:
    """Tournament-scope site + hotel (audit D5/D6).

    The UI already filters both pickers to the active tournament; the API used
    to accept any valid site/room_block FK, so a scripted or mistyped client
    could attach mileage to a venue from another event or book a room block
    reserved for a different tournament. NULL is always allowed (TBD site /
    no hotel).
    """
    if site_id is not None:
        cur.execute(
            "SELECT 1 FROM tournament_site "
            "WHERE tournament_id = %s AND site_id = %s",
            (tournament_id, site_id),
        )
        if cur.fetchone() is None:
            # Distinguish "site doesn't exist" (FK would fail later) from
            # "exists but isn't linked to this event" so the TD gets a clear cue.
            cur.execute("SELECT 1 FROM site WHERE id = %s", (site_id,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=400, detail="site_id does not exist")
            raise HTTPException(
                status_code=400,
                detail="site_id is not linked to this tournament",
            )
    if room_block_id is not None:
        cur.execute(
            "SELECT tournament_id FROM room_block WHERE id = %s",
            (room_block_id,),
        )
        rb = cur.fetchone()
        if rb is None:
            raise HTTPException(status_code=400, detail="room_block_id does not exist")
        if rb["tournament_id"] != tournament_id:
            raise HTTPException(
                status_code=400,
                detail="room_block_id does not belong to this tournament",
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
    rows = _summaries(cur, cur.fetchall())
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

def _audit(cur, assignment_id, action, detail, username):
    """Append-only WHO/WHEN/WHAT trail (P4-5). Identity is denormalized so the
    trail survives the assignment being deleted (FK goes NULL)."""
    cur.execute(
        "INSERT INTO assignment_audit "
        "  (assignment_id, tournament_id, official_id, official_name, changed_by, action, detail) "
        "SELECT a.id, a.tournament_id, a.official_id, "
        "       o.last_name || ', ' || o.first_name, %s, %s, %s::jsonb "
        "FROM assignment a JOIN official o ON o.id = a.official_id WHERE a.id = %s",
        (username, action, json.dumps(detail) if detail else None, assignment_id),
    )

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


