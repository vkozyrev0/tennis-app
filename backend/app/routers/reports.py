"""Tournament reports — officials confirmation roster + pay/mileage totals.

Reuses the assignment summary (per-day roles, computed pay/mileage, hotel
date-mismatch flag) and adds the official's dietary restrictions (audit §2.3) and
tournament-level totals. This is the Phase 1 "print both reports" deliverable.
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep
from .assignments import _ASG_SELECT, _summaries

router = APIRouter(prefix="/api/tournaments", tags=["reports"])


@router.get("/{tournament_id}/missing-distances")
def missing_distances(tournament_id: int, conn=Depends(db_dep)):
    """Official↔site pairs with no mileage distance on file — for these the
    reimbursement mileage can't be computed (it's left null). One row per affected
    assignment (official + their venue + worked-day count), so the TD fills them
    all from one place instead of card-by-card. Assignments with no site are
    skipped (mileage needs a venue)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT a.id AS assignment_id, o.id AS official_id, "
            "       o.first_name, o.last_name, a.site_id, "
            "       COALESCE(s.code, s.name) AS site_label, "
            "       (SELECT count(*) FROM assignment_day ad WHERE ad.assignment_id = a.id) AS days "
            "FROM assignment a "
            "JOIN official o ON o.id = a.official_id "
            "JOIN site s ON s.id = a.site_id "
            "WHERE a.tournament_id = %s AND a.site_id IS NOT NULL "
            "  AND NOT EXISTS (SELECT 1 FROM official_site_distance d "
            "                  WHERE d.official_id = a.official_id AND d.site_id = a.site_id) "
            "ORDER BY s.code, s.name, o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()
    items = [{
        "assignment_id": r["assignment_id"], "official_id": r["official_id"],
        "official_name": f'{r["last_name"]}, {r["first_name"]}',
        "site_id": r["site_id"], "site_label": r["site_label"], "days": r["days"],
    } for r in rows]
    return {"tournament_id": tournament_id, "items": items, "count": len(items)}


@router.get("/{tournament_id}/officials-without-login")
def officials_without_login(tournament_id: int, conn=Depends(db_dep)):
    """Officials assigned to this tournament who have NO self-service account —
    they can't accept/decline, so their assignments sit pending. Flag them so the
    TD can create logins. Includes whether an email is on file (needed to send
    credentials) and their current response status."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT DISTINCT o.id, o.first_name, o.last_name, o.email, "
            "       a.response_status "
            "FROM assignment a JOIN official o ON o.id = a.official_id "
            "WHERE a.tournament_id = %s "
            "  AND NOT EXISTS (SELECT 1 FROM user_account u "
            "                  WHERE u.official_id = o.id AND u.role = 'official') "
            "ORDER BY o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()
    officials = [{
        "official_id": r["id"], "official_name": f'{r["last_name"]}, {r["first_name"]}',
        "email": r["email"], "has_email": bool(r["email"]),
        "response_status": r["response_status"],
    } for r in rows]
    return {"tournament_id": tournament_id, "officials": officials, "count": len(officials)}


@router.get("/{tournament_id}/dietary-summary")
def dietary_summary(tournament_id: int, conn=Depends(db_dep)):
    """Catering rollup: officials staffed on this tournament grouped by their
    dietary restriction (free text, normalised case-insensitively), with a count +
    the names for each, plus how many have none. Declined officials are excluded
    (they aren't being fed). Hand the counts to catering."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, name FROM tournament WHERE id = %s", (tournament_id,))
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT DISTINCT o.id, o.first_name, o.last_name, o.dietary_restrictions "
            "FROM assignment a JOIN official o ON o.id = a.official_id "
            "WHERE a.tournament_id = %s AND a.response_status <> 'declined'",
            (tournament_id,),
        )
        rows = cur.fetchall()

    groups: dict = {}     # normalized key -> {label, people}
    none_people: list = []
    for r in rows:
        name = f'{r["last_name"]}, {r["first_name"]}'
        raw = (r["dietary_restrictions"] or "").strip()
        if not raw:
            none_people.append(name)
            continue
        key = raw.lower()
        g = groups.setdefault(key, {"restriction": raw, "people": []})
        g["people"].append(name)
    items = sorted(
        ({"restriction": g["restriction"], "count": len(g["people"]),
          "people": sorted(g["people"])} for g in groups.values()),
        key=lambda x: (-x["count"], x["restriction"].lower()),
    )
    total = len(rows)
    return {
        "tournament": {"id": t["id"], "name": t["name"]},
        "items": items,
        "with_restrictions": total - len(none_people),
        "none_count": len(none_people),
        "total_people": total,
    }


@router.get("/{tournament_id}/schedule")
def day_schedule(tournament_id: int, conn=Depends(db_dep)):
    """Day-by-day operational schedule: for each play-window day, who's working —
    official, role, and site — so the TD has a day-of sheet. One entry per
    (official, day) since an official works a single role per date. Declined
    assignments are excluded (they're not actually staffed); a per-day headcount
    is included so thin days stand out."""
    from datetime import timedelta
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, play_start_date, play_end_date FROM tournament WHERE id = %s",
            (tournament_id,),
        )
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT ad.work_date, ad.working_as, a.response_status, "
            "       o.first_name, o.last_name, "
            "       COALESCE(s.code, s.name) AS site_label "
            "FROM assignment_day ad "
            "JOIN assignment a ON a.id = ad.assignment_id "
            "JOIN official o ON o.id = a.official_id "
            "LEFT JOIN site s ON s.id = a.site_id "
            "WHERE a.tournament_id = %s AND a.response_status <> 'declined' "
            "ORDER BY ad.work_date, site_label NULLS FIRST, o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()

    by_date: dict = {}
    for r in rows:
        by_date.setdefault(r["work_date"].isoformat(), []).append({
            "official_name": f'{r["last_name"]}, {r["first_name"]}',
            "working_as": r["working_as"],
            "site_label": r["site_label"],
            "response_status": r["response_status"],
        })
    days = []
    start, end = t["play_start_date"], t["play_end_date"]
    if start and end and start <= end:
        d = start
        while d <= end:
            iso = d.isoformat()
            ents = by_date.get(iso, [])
            days.append({"date": iso, "entries": ents, "count": len(ents)})
            d += timedelta(days=1)
    return {"tournament": {"id": t["id"], "name": t["name"]}, "days": days}


@router.get("/{tournament_id}/rooming-list")
def rooming_list(tournament_id: int, conn=Depends(db_dep)):
    """Per-hotel-block rooming list to hand to the hotel: each official-comp block
    with its occupants (name, the nights they need = their worked-day span, and
    dietary restrictions). Declined assignments are excluded (their room is freed).
    Feeds the printable + CSV rooming-list export."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, name FROM tournament WHERE id = %s", (tournament_id,))
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "SELECT rb.id AS block_id, h.name AS hotel_name, rb.confirmation_number, "
            "       rb.check_in, rb.check_out, rb.room_count, "
            "       a.id AS assignment_id, a.response_status, "
            "       o.first_name, o.last_name, o.dietary_restrictions, "
            "       o.phone AS official_phone, "
            "       ad.first_day, ad.last_day "
            "FROM room_block rb "
            "JOIN hotel h ON h.id = rb.hotel_id "
            "LEFT JOIN assignment a "
            "       ON a.room_block_id = rb.id AND a.response_status <> 'declined' "
            "LEFT JOIN official o ON o.id = a.official_id "
            "LEFT JOIN (SELECT assignment_id, min(work_date) AS first_day, "
            "                  max(work_date) AS last_day "
            "           FROM assignment_day GROUP BY assignment_id) ad "
            "       ON ad.assignment_id = a.id "
            "WHERE rb.tournament_id = %s AND rb.kind = 'official' "
            "ORDER BY h.name, rb.id, o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()

    blocks: dict = {}
    order: list = []
    for r in rows:
        bid = r["block_id"]
        if bid not in blocks:
            blocks[bid] = {
                "block_id": bid, "hotel_name": r["hotel_name"],
                "confirmation_number": r["confirmation_number"],
                "check_in": r["check_in"].isoformat() if r["check_in"] else None,
                "check_out": r["check_out"].isoformat() if r["check_out"] else None,
                "room_count": r["room_count"], "occupants": [],
            }
            order.append(bid)
        if r["assignment_id"] is not None:
            blocks[bid]["occupants"].append({
                "official_name": f'{r["last_name"]}, {r["first_name"]}',
                "dietary_restrictions": r["dietary_restrictions"],
                "official_phone": r["official_phone"],
                "first_night": r["first_day"].isoformat() if r["first_day"] else None,
                "last_night": r["last_day"].isoformat() if r["last_day"] else None,
                "response_status": r["response_status"],
            })
    blocks_out = [blocks[b] for b in order]
    totals = {
        "blocks": len(blocks_out),
        "rooms_reserved": sum(b["room_count"] for b in blocks_out),
        "occupants": sum(len(b["occupants"]) for b in blocks_out),
    }
    return {"tournament": {"id": t["id"], "name": t["name"]},
            "blocks": blocks_out, "totals": totals}


@router.get("/{tournament_id}/reports/officials")
def officials_report(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, type, play_start_date, play_end_date "
            "FROM tournament WHERE id = %s",
            (tournament_id,),
        )
        t = cur.fetchone()
        if t is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        t["play_start_date"] = t["play_start_date"].isoformat()
        t["play_end_date"] = t["play_end_date"].isoformat()

        cur.execute(
            _ASG_SELECT
            + " WHERE a.tournament_id = %s ORDER BY o.last_name, o.first_name",
            (tournament_id,),
        )
        rows = cur.fetchall()

        # _summary already carries dietary_restrictions (joined in _ASG_SELECT),
        # so no per-official follow-up query is needed.
        officials = _summaries(cur, rows)

        # Non-official support staff round out the TD's staffing plan — listed
        # separately (no pay/mileage/days), grouped by role in the report.
        cur.execute(
            "SELECT s.id, s.name, s.role, s.phone, s.email, s.notes, s.daily_rate, "
            "       COALESCE(array_agg(d.work_date ORDER BY d.work_date) "
            "                FILTER (WHERE d.work_date IS NOT NULL), '{}') AS days "
            "FROM tournament_staff s LEFT JOIN staff_day d ON d.staff_id = s.id "
            "WHERE s.tournament_id = %s GROUP BY s.id ORDER BY s.role, s.name",
            (tournament_id,),
        )
        staff = cur.fetchall()
        for s in staff:
            s["days"] = [d.isoformat() for d in s["days"]]
            # Flat daily rate × scheduled days (audit-trivial; no snapshot needed).
            rate = float(s["daily_rate"]) if s["daily_rate"] is not None else None
            s["daily_rate"] = rate
            s["pay"] = round(rate * len(s["days"]), 2) if rate else 0.0

        # Room-block pickup: per OFFICIAL comp block, rooms reserved vs assigned
        # (pickup), so the TD can release unused rooms before the hotel cutoff.
        # A DECLINED assignment won't occupy its room, so it is excluded from the
        # pickup count — otherwise the reassign flow (which keeps the declined row
        # pointing at the block, plus a replacement also pointing at it) would
        # double-count and hide rooms the TD should release.
        cur.execute(
            "SELECT rb.id, h.name AS hotel_name, rb.confirmation_number, "
            "       rb.check_in, rb.check_out, rb.room_count, "
            "       (SELECT count(*) FROM assignment a WHERE a.room_block_id = rb.id "
            "        AND a.response_status <> 'declined') AS assigned "
            "FROM room_block rb JOIN hotel h ON h.id = rb.hotel_id "
            "WHERE rb.tournament_id = %s AND rb.kind = 'official' "
            "ORDER BY h.name, rb.id",
            (tournament_id,),
        )
        room_blocks = cur.fetchall()
        for b in room_blocks:
            b["check_in"] = b["check_in"].isoformat() if b["check_in"] else None
            b["check_out"] = b["check_out"].isoformat() if b["check_out"] else None
            b["assigned"] = int(b["assigned"])
            b["remaining"] = b["room_count"] - b["assigned"]

    # Per-day coverage: how many officials work each day of the play window, so a
    # day with ZERO officials is surfaced before the event. Built from the
    # already-loaded officials' days (in-window dates only) — no extra query.
    day_counts: dict[str, int] = {}
    for o in officials:
        for d in o["days"]:
            day_counts[d["work_date"]] = day_counts.get(d["work_date"], 0) + 1
    coverage = []
    cur_day = date.fromisoformat(t["play_start_date"])
    end_day = date.fromisoformat(t["play_end_date"])
    while cur_day <= end_day:
        iso = cur_day.isoformat()
        coverage.append({"date": iso, "officials": day_counts.get(iso, 0)})
        cur_day += timedelta(days=1)
    uncovered_days = [c["date"] for c in coverage if c["officials"] == 0]

    # Per-site coverage: officials per site per day, finer than the tournament-wide
    # counts above, so the TD spots a specific venue/day that's thin or empty.
    # Rows include EVERY site linked to the tournament (so a fully-uncovered site
    # still shows) plus a "(no site)" row if any assignment lacks a venue.
    with conn.cursor() as cur:
        cur.execute(
            "SELECT s.id, COALESCE(s.code, s.name) AS label "
            "FROM tournament_site ts JOIN site s ON s.id = ts.site_id "
            "WHERE ts.tournament_id = %s ORDER BY label",
            (tournament_id,),
        )
        linked_sites = cur.fetchall()
        # Certification pool — every official + the certs they hold, so the TD can
        # plan role coverage against the available pool (e.g. "I have 5 chairs but
        # only staffed 2 Tuesday"). Global (not tournament-scoped) on purpose.
        cur.execute(
            "SELECT o.id, o.last_name, o.first_name, "
            "  COALESCE(array_agg(c.cert_type::text ORDER BY c.cert_type::text) "
            "           FILTER (WHERE c.cert_type IS NOT NULL), ARRAY[]::text[]) AS certs "
            "FROM official o LEFT JOIN certification c ON c.official_id = o.id "
            "GROUP BY o.id ORDER BY o.last_name, o.first_name"
        )
        pool_rows = cur.fetchall()
    # (site_id | None) -> {date -> count}
    site_counts: dict = {}
    window = {c["date"] for c in coverage}
    for o in officials:
        sid = o["site_id"]
        for d in o["days"]:
            if d["work_date"] in window:
                site_counts.setdefault(sid, {})[d["work_date"]] = (
                    site_counts.get(sid, {}).get(d["work_date"], 0) + 1
                )
    site_rows = [{"site_id": s["id"], "site_label": s["label"]} for s in linked_sites]
    # add a synthetic row for assignments with no site, if any officials lack one
    if None in site_counts:
        site_rows.append({"site_id": None, "site_label": "(no site)"})
    site_coverage = []
    for row in site_rows:
        counts = site_counts.get(row["site_id"], {})
        site_coverage.append({
            **row,
            "by_date": [{"date": c["date"], "officials": counts.get(c["date"], 0)}
                        for c in coverage],
        })

    # Certification pool: officials × the certs they hold + a count per cert.
    cert_pool_officials = [
        {"official_name": f'{r["last_name"]}, {r["first_name"]}', "certs": list(r["certs"])}
        for r in pool_rows
    ]
    cert_counts: dict = {}
    for r in cert_pool_officials:
        for ct in r["certs"]:
            cert_counts[ct] = cert_counts.get(ct, 0) + 1
    cert_pool = {"officials": cert_pool_officials, "counts": cert_counts}

    # Per-role coverage: officials working each ROLE (cert type) per day, so the
    # TD spots a day thin on a needed role (e.g. chairs Mon–Wed but none Thu) —
    # not just total headcount. An official works one role per date
    # (UNIQUE(assignment_id, work_date)), so a per-date row-count = officials.
    role_counts: dict = {}
    for o in officials:
        for d in o["days"]:
            if d["work_date"] in window:
                role = d["working_as"]
                role_counts.setdefault(role, {})[d["work_date"]] = (
                    role_counts.get(role, {}).get(d["work_date"], 0) + 1
                )
    # Rows = roles ASSIGNED in this tournament ∪ roles with CERTIFIED holders, so
    # a role you could staff but didn't (zero row) is visible. `holders` (the
    # certified pool for that role) lets the UI flag a day where staffed < holders
    # — "you have the chairs, you just didn't staff them".
    role_coverage = [
        {"role": role,
         "holders": cert_counts.get(role, 0),
         "by_date": [{"date": c["date"], "officials": role_counts.get(role, {}).get(c["date"], 0)}
                     for c in coverage]}
        for role in sorted(set(role_counts) | set(cert_counts))
    ]

    totals = {
        "staff_count": len(staff),
        "official_count": len(officials),
        # Total official-days worked across the tournament (per-official load is
        # shown in the roster's Days column; this is the grand total).
        "official_days_total": sum(len(o["days"]) for o in officials),
        "pay": round(sum(o["pay"] for o in officials), 2),
        "mileage": round(sum((o["mileage"] or 0.0) for o in officials), 2),
        "missing_distance_count": sum(1 for o in officials if o["missing_distance"]),
        "hotel_mismatch_count": sum(1 for o in officials if o["hotel_date_mismatch"]),
        "out_of_window_count": sum(1 for o in officials if o["work_date_out_of_window"]),
        "conflict_count": sum(1 for o in officials if o["has_conflict"]),
        "availability_count": sum(1 for o in officials if o.get("days_outside_availability")),
        "uncertified_count": sum(1 for o in officials if o.get("has_uncertified")),
        "declined_count": sum(1 for o in officials if o.get("response_status") == "declined"),
        "pending_count": sum(1 for o in officials if o.get("response_status") == "pending"),
        "staff_pay": round(sum(s["pay"] for s in staff), 2),
        # Official room-block pickup roll-up (right-sizing before hotel cutoff).
        "rooms_reserved": sum(b["room_count"] for b in room_blocks),
        "rooms_assigned": sum(b["assigned"] for b in room_blocks),
        "rooms_remaining": sum(b["remaining"] for b in room_blocks),
        # Days in the play window with zero officials assigned (coverage gaps).
        "uncovered_days_count": len(uncovered_days),
    }
    totals["total"] = round(totals["pay"] + totals["mileage"], 2)
    return {"tournament": t, "officials": officials, "staff": staff,
            "room_blocks": room_blocks, "coverage": coverage,
            "site_coverage": site_coverage, "role_coverage": role_coverage,
            "cert_pool": cert_pool,
            "uncovered_days": uncovered_days, "totals": totals}
