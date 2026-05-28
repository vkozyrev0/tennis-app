"""End-to-end test for a tournament director's full workflow.

Runs the same API calls a TD would make from the UI, in the same order:

  1. Setup catalog: create site(s), official(s) with certifications, players,
     hotel + room blocks, rate(s), distance(s), division/event lookups.
  2. Tournament: create it; attach sites; build the roster (including a
     walk-in player created inline; an alternate; a player with a t-shirt).
  3. Availability: officials self-mark their dates (admin-side).
  4. Assignments: assign officials → site + hotel room block; add per-day
     working_as entries; verify pay + mileage snapshots; verify the room
     block's `rooms_remaining` decrements.
  5. Part B intake: receive an email; suggest a classification (triage);
     file it as a late entry; receive another email and file as a
     withdrawal (with reason); confirm roster status flips to 'withdrawn'.
  6. Player preferences: scheduling avoidance, division flex, pairing
     avoidance group, doubles mutual request → verify both sides pair.
  7. Player hotels (Part B): record where a player is staying; confirm
     the per-hotel summary + per-lodging-plan summary picks it up.
  8. T-shirt order tracking: snapshot today's requested counts.
  9. Reports: pull the staffing-plan report; verify totals + flags.
 10. Cleanup: optimistic concurrency on the Players grid is exercised by
     a double-write race.

This test stays at the API boundary (no DOM driving) and uses only paths
the UI actually hits, so a regression in any of the user-visible flows
breaks it. Idempotent: every entity is created with a uuid-tagged name
so the test can run repeatedly without colliding with prior runs.
"""
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
# NOTE: don't log in at module load. The auth router rotates sessions on
# every login (audit C3 — invalidates any prior session for that user), so
# logging in here at collection time would kill the session test_smoke.py's
# TestClient already established at ITS module load. Login is done lazily
# inside the test function instead.


def _db_up() -> bool:
    return client.get("/api/health").json().get("db") == "ok"


pytestmark = pytest.mark.skipif(not _db_up(), reason="Postgres not reachable")


def _u(prefix: str = "") -> str:
    """Short unique tag so repeated runs don't collide on UNIQUE constraints."""
    return prefix + uuid.uuid4().hex[:6]


def _ok(r, code=201):
    assert r.status_code == code, f"expected {code}, got {r.status_code}: {r.text}"
    return r.json()


def test_td_full_workflow():
    """Walk through a tournament from creation to staffing report."""
    # Lazy login — see module docstring re: session-rotation interaction.
    client.post("/api/auth/login",
                json={"username": "admin", "password": "admin"})

    # ------------------------------------------------------------------
    # 1. Setup — durable catalogs the TD reuses across tournaments.
    # ------------------------------------------------------------------
    site = _ok(client.post("/api/sites", json={
        "code": "E2E-" + _u(), "name": "Riverside Tennis Center",
        "street": "100 Court Ln", "city": "Atlanta", "state": "GA", "zip": "30301",
    }))
    site_id = site["id"]

    hotel = _ok(client.post("/api/hotels", json={
        "name": "Riverside Marriott " + _u(),
        "street": "120 Court Ln", "city": "Atlanta", "state": "GA",
    }))
    hotel_id = hotel["id"]

    # Cert rate. The pay snapshot picks the rate with the most-recent
    # effective_from ≤ work_date. The seed + earlier test runs may have
    # written newer rows for chair_umpire, so we don't assert an exact
    # per-day rate later — we compute the expected pay from whatever
    # rate the API resolves at play_start. The POST below is best-effort
    # (idempotent across runs via uuid-offset effective_from); a 409
    # collision with an existing row is fine.
    eff = (date.today() - timedelta(days=uuid.uuid4().int % 3650 + 1)).isoformat()
    client.post("/api/rates", json={
        "cert_type": "chair_umpire", "rate_per_day": 175.00, "effective_from": eff,
    })

    # Two officials — one will work the tournament, one is on backup.
    o1 = _ok(client.post("/api/officials", json={
        "first_name": "Casey", "last_name": "Referee-" + _u(),
        "street": "1 Linesman Way", "city": "Atlanta", "state": "GA",
        "phone": "555-1010", "email": f"casey+{_u()}@example.com",
        "dietary_restrictions": "vegetarian",
    }))
    o2 = _ok(client.post("/api/officials", json={
        "first_name": "Robin", "last_name": "Chair-" + _u(),
        "city": "Macon", "state": "GA",
    }))

    # Each official needs at least one certification — admin assigns it.
    _ok(client.post(f"/api/officials/{o1['id']}/certifications",
                    json={"cert_type": "chair_umpire"}))
    _ok(client.post(f"/api/officials/{o2['id']}/certifications",
                    json={"cert_type": "roving_official"}))
    certs1 = client.get(f"/api/officials/{o1['id']}/certifications").json()
    assert any(c["cert_type"] == "chair_umpire" for c in certs1)

    # Mileage distance (Setup → Distances) for o1↔site so pay snapshots
    # can compute mileage.
    _ok(client.post("/api/distances", json={
        "official_id": o1["id"], "site_id": site_id,
        "one_way_miles": 25.0, "source": "manual",
    }))

    # Pre-create a couple of players in Setup (gender + birthdate are required).
    p1 = _ok(client.post("/api/players", json={
        "usta_number": "E2E1-" + _u(),
        "first_name": "Avery", "last_name": "Junior-" + _u(),
        "gender": "female", "birthdate": "2012-04-15",
    }))
    p2 = _ok(client.post("/api/players", json={
        "usta_number": "E2E2-" + _u(),
        "first_name": "Jordan", "last_name": "Sibling-" + _u(),
        "gender": "male", "birthdate": "2013-08-02",
    }))
    p3 = _ok(client.post("/api/players", json={
        "usta_number": "E2E3-" + _u(),
        "first_name": "Sam", "last_name": "Alternate-" + _u(),
        "gender": "female", "birthdate": "2011-11-30",
    }))
    p4 = _ok(client.post("/api/players", json={
        "usta_number": "E2E4-" + _u(),
        "first_name": "Riley", "last_name": "Partner-" + _u(),
        "gender": "female", "birthdate": "2012-01-12",
    }))

    # Sanity: divisions + events catalogs are populated by seed.
    divs = client.get("/api/divisions?tournament_type=junior").json()
    events = client.get("/api/events?tournament_type=junior").json()
    assert len(divs) > 0 and len(events) > 0

    # ------------------------------------------------------------------
    # 2. Tournament — create the working object + attach sites.
    # ------------------------------------------------------------------
    play_start = date.today() + timedelta(days=30)
    play_end = play_start + timedelta(days=3)  # 4-day tournament
    t = _ok(client.post("/api/tournaments", json={
        "name": "E2E Junior Open " + _u(), "type": "junior",
        "play_start_date": play_start.isoformat(),
        "play_end_date": play_end.isoformat(),
        "registration_deadline": (play_start - timedelta(days=14)).isoformat(),
        "late_entry_deadline": (play_start - timedelta(days=2)).isoformat(),
    }))
    tid = t["id"]

    # Bad date order is rejected at the model layer (mirrors UI form validation).
    bad = client.post("/api/tournaments", json={
        "name": "bad-" + _u(), "type": "adult",
        "play_start_date": play_end.isoformat(),
        "play_end_date": play_start.isoformat(),
    })
    assert bad.status_code == 422

    # Attach the site so it's reachable from the tournament workspace.
    sites_attached = _ok(client.put(f"/api/tournaments/{tid}/sites",
                                    json={"site_ids": [site_id]}), code=200)
    assert [s["id"] for s in sites_attached] == [site_id]

    # ------------------------------------------------------------------
    # 3. Roster build — three flavors of add:
    #    a) link an existing Setup player by player_id
    #    b) USTA-by-id with status=alternate
    #    c) walk-in: brand-new player created inline by USTA + gender
    # ------------------------------------------------------------------
    r_a = _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "player_id": p1["id"], "age_division": "G14", "events": "Singles, Doubles",
        "selection_status": "selected", "t_shirt_size": "youth medium",
        "dietary_preference": "no nuts",
    }))
    assert r_a["t_shirt_size"] == "Youth Medium"  # normalized to canonical

    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "player_id": p2["id"], "age_division": "B12", "events": "Singles",
        "selection_status": "selected", "t_shirt_size": "Adult Small",
    }))
    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "player_id": p3["id"], "age_division": "G16",
        "selection_status": "alternate", "t_shirt_size": "Adult Medium",
    }))
    _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "player_id": p4["id"], "age_division": "G14",
        "selection_status": "selected",
    }))
    walkin_usta = "WALK-" + _u()
    walkin = _ok(client.post(f"/api/tournaments/{tid}/players", json={
        "usta_number": walkin_usta, "first_name": "Walter",
        "last_name": "Inn-" + _u(), "gender": "male",
        "age_division": "B14", "selection_status": "selected",
    }))
    assert walkin["usta_number"] == walkin_usta

    roster = client.get(f"/api/tournaments/{tid}/players").json()
    assert len(roster) == 5
    status_counts = {r["selection_status"] for r in roster}
    assert status_counts == {"selected", "alternate"}

    # ------------------------------------------------------------------
    # 4. Availability — admin sets each official's available dates.
    # ------------------------------------------------------------------
    all_days = [(play_start + timedelta(days=i)).isoformat() for i in range(4)]
    _ok(client.put(f"/api/tournaments/{tid}/availability",
                   json={"official_id": o1["id"], "dates": all_days,
                         "hotel_needed": True}), code=200)
    # o2 only available the last two days
    _ok(client.put(f"/api/tournaments/{tid}/availability",
                   json={"official_id": o2["id"], "dates": all_days[2:],
                         "hotel_needed": False}), code=200)
    avail = client.get(f"/api/tournaments/{tid}/availability").json()
    assert len([a for a in avail if a["official_id"] == o1["id"]]) == 4
    assert len([a for a in avail if a["official_id"] == o2["id"]]) == 2

    # ------------------------------------------------------------------
    # 5. Room blocks — book officials' rooms; we'll assign one to o1.
    # ------------------------------------------------------------------
    rb = _ok(client.post("/api/room-blocks", json={
        "hotel_id": hotel_id, "tournament_id": tid, "kind": "official",
        "confirmation_number": "OFF-CONF-" + _u(),
        "check_in": all_days[0], "check_out": all_days[-1],
        "room_count": 3,
    }))
    assert rb["rooms_remaining"] == 3

    # ------------------------------------------------------------------
    # 6. Assignments — assign o1 to the site + the official room block.
    # ------------------------------------------------------------------
    asg = _ok(client.post(f"/api/tournaments/{tid}/assignments", json={
        "official_id": o1["id"], "site_id": site_id, "room_block_id": rb["id"],
    }))
    aid = asg["id"]
    # Add three working_as days at chair_umpire ($175/day) on consecutive days
    for d in all_days[:3]:
        _ok(client.post(f"/api/assignments/{aid}/days",
                        json={"work_date": d, "working_as": "chair_umpire"}))

    # Reload the assignment list with computed totals (pay + mileage snapshots).
    assignments = client.get(f"/api/tournaments/{tid}/assignments").json()
    me = next(a for a in assignments if a["id"] == aid)
    # Pay = 3 × rate_applied (the rate snapshotted per day-row). We don't
    # hardcode the dollar amount because the seed/prior runs may shift the
    # most-recent chair_umpire rate; compute expected from rate_applied.
    rate_applied = me["days"][0]["rate_applied"]
    assert all(d["rate_applied"] == rate_applied for d in me["days"])
    assert me["pay"] == round(rate_applied * 3, 2), me
    # Mileage column may be 0.0 if the IRS rate isn't configured in this
    # environment — but the snapshot must be NOT NULL (the column is set
    # at assignment time) and missing_distance must be False (we wrote a
    # distance row for o1 ↔ site above).
    assert me["mileage"] is not None
    assert me["missing_distance"] is False
    assert me["hotel_name"] == hotel["name"]
    # Room block usage reflected in rooms_remaining.
    rb_after = next(r for r in client.get(f"/api/room-blocks?tournament_id={tid}").json()
                    if r["id"] == rb["id"])
    assert rb_after["rooms_remaining"] == 2

    # ------------------------------------------------------------------
    # 7. Part B — inbox triage, late entry, withdrawal.
    # ------------------------------------------------------------------
    # New email arrives (TD pastes from forwarded mail).
    em1 = _ok(client.post("/api/emails", json={
        "tournament_id": tid, "from_address": "parent1@example.com",
        "subject": "Late entry for tournament", "body": "Can our child still enter? B14 singles.",
    }))
    # Local heuristic triage (agent v0) suggests a classification.
    sug = _ok(client.post(f"/api/emails/{em1['id']}/suggest"), code=200)
    assert sug["classification"] == "late_entry"
    # TD files the email as a late entry — player must already exist in Setup
    # (audit B1 — inbox flows refuse new players).
    late_usta = "LATE-" + _u()
    late_player = _ok(client.post("/api/players", json={
        "usta_number": late_usta, "first_name": "Lee", "last_name": "Tardy-" + _u(),
        "gender": "male", "birthdate": "2012-06-06",
    }))
    le = _ok(client.post(f"/api/tournaments/{tid}/late-entries", json={
        "usta_number": late_usta, "first_name": late_player["first_name"],
        "last_name": late_player["last_name"],
        "age_division": "B14", "events": "Singles",
        "request_date": (date.today() - timedelta(days=1)).isoformat(),
        "request_time": "2:30 PM", "source_email_id": em1["id"],
    }))
    # Filing the email flips its status + adds the player to the roster
    # (source=late_entry).
    inbox = client.get(f"/api/emails?tournament_id={tid}").json()
    em1_after = next(m for m in inbox if m["id"] == em1["id"])
    assert em1_after["status"] == "filed" and em1_after["classification"] == "late_entry"
    roster_after_late = client.get(f"/api/tournaments/{tid}/players").json()
    assert any(p["usta_number"] == late_usta for p in roster_after_late)

    # Withdrawal: file an email; reason is required (p4 wasn't an alternate).
    em2 = _ok(client.post("/api/emails", json={
        "tournament_id": tid, "from_address": "parent2@example.com",
        "subject": "Need to withdraw", "body": "Riley has a fever and must withdraw.",
    }))
    needs_reason = client.post(f"/api/tournaments/{tid}/withdrawals", json={
        "usta_number": p4["usta_number"], "first_name": p4["first_name"],
        "last_name": p4["last_name"], "events": "Singles",
        "source_email_id": em2["id"],
    })
    assert needs_reason.status_code == 400, needs_reason.text  # missing reason
    wd = _ok(client.post(f"/api/tournaments/{tid}/withdrawals", json={
        "usta_number": p4["usta_number"], "first_name": p4["first_name"],
        "last_name": p4["last_name"], "events": "Singles",
        "reason": "Illness — fever", "notes": "Doctor's note pending",
        "source_email_id": em2["id"],
    }))
    # The roster entry for p4 should now be withdrawn.
    roster_after_wd = client.get(f"/api/tournaments/{tid}/players").json()
    p4_entry = next(r for r in roster_after_wd if r["usta_number"] == p4["usta_number"])
    assert p4_entry["selection_status"] == "withdrawn"

    # ------------------------------------------------------------------
    # 8. Player preferences — scheduling, divflex, pairing, doubles.
    # ------------------------------------------------------------------
    # Scheduling avoidance for p1 (e.g. religious morning service).
    _ok(client.post(f"/api/tournaments/{tid}/scheduling-avoidances", json={
        "usta_number": p1["usta_number"], "first_name": p1["first_name"],
        "last_name": p1["last_name"],
        "avoid_day": "Saturday", "avoid_time_range": "before 10am",
    }))
    sched = client.get(f"/api/tournaments/{tid}/scheduling-avoidances").json()
    assert any(s["usta_number"] == p1["usta_number"] for s in sched)

    # Division flexibility for p3 (willing to bump up).
    _ok(client.post(f"/api/tournaments/{tid}/division-flex", json={
        "usta_number": p3["usta_number"], "first_name": p3["first_name"],
        "last_name": p3["last_name"],
        "home_division": "G16", "willing_divisions": "G14, G18",
    }))

    # Pairing avoidance group (juniors): two siblings who must not draw
    # each other in round 1.
    p_sib1 = _ok(client.post("/api/players", json={
        "usta_number": "SIB1-" + _u(), "first_name": "Pat",
        "last_name": "Sibling-" + _u(), "gender": "female", "birthdate": "2012-03-03",
    }))
    p_sib2 = _ok(client.post("/api/players", json={
        "usta_number": "SIB2-" + _u(), "first_name": "Sam",
        "last_name": "Sibling-" + _u(), "gender": "female", "birthdate": "2013-09-09",
    }))
    grp = _ok(client.post(f"/api/tournaments/{tid}/pairing-avoidances", json={
        "age_division": "G14", "relationship": "siblings",
        "members": [
            {"usta_number": p_sib1["usta_number"], "first_name": p_sib1["first_name"], "last_name": p_sib1["last_name"]},
            {"usta_number": p_sib2["usta_number"], "first_name": p_sib2["first_name"], "last_name": p_sib2["last_name"]},
        ],
    }))
    assert len(grp["members"]) == 2

    # Doubles: file two mutual requests (each player names the other);
    # the second filing triggers the pair.
    p_d1 = _ok(client.post("/api/players", json={
        "usta_number": "DBL1-" + _u(), "first_name": "Dana",
        "last_name": "Doubles-" + _u(), "gender": "female", "birthdate": "2012-05-05",
    }))
    p_d2 = _ok(client.post("/api/players", json={
        "usta_number": "DBL2-" + _u(), "first_name": "Drew",
        "last_name": "Doubles-" + _u(), "gender": "female", "birthdate": "2012-07-07",
    }))
    # Put them on the roster (random/mutual pair logic refuses to verify
    # for un-rostered players — audit F15).
    for p in (p_d1, p_d2):
        _ok(client.post(f"/api/tournaments/{tid}/players", json={
            "player_id": p["id"], "age_division": "G14",
            "selection_status": "selected",
        }))
    r1 = _ok(client.post(f"/api/tournaments/{tid}/doubles-requests", json={
        "usta_number": p_d1["usta_number"], "first_name": p_d1["first_name"],
        "last_name": p_d1["last_name"], "age_division": "G14",
        "wants_random": False, "partner_usta": p_d2["usta_number"],
    }), code=201)
    assert r1["paired"] is False  # only one side filed
    r2 = _ok(client.post(f"/api/tournaments/{tid}/doubles-requests", json={
        "usta_number": p_d2["usta_number"], "first_name": p_d2["first_name"],
        "last_name": p_d2["last_name"], "age_division": "G14",
        "wants_random": False, "partner_usta": p_d1["usta_number"],
    }), code=201)
    assert r2["paired"] is True  # mutual match
    doubles_state = client.get(f"/api/tournaments/{tid}/doubles").json()
    assert len(doubles_state["pairs"]) == 1
    assert {doubles_state["pairs"][0]["player1_id"],
            doubles_state["pairs"][0]["player2_id"]} == {p_d1["id"], p_d2["id"]}

    # ------------------------------------------------------------------
    # 9. Player hotels — record where p1 is staying.
    # ------------------------------------------------------------------
    _ok(client.post(f"/api/tournaments/{tid}/player-hotels", json={
        "usta_number": p1["usta_number"], "first_name": p1["first_name"],
        "last_name": p1["last_name"], "hotel_name": hotel["name"],
        "lodging_plan": "Hotel",
    }))
    hsum = client.get(f"/api/tournaments/{tid}/hotel-summary").json()
    assert any(h["hotel_name"].lower() == hotel["name"].lower() and h["players"] == 1
               for h in hsum)
    lsum = client.get(f"/api/tournaments/{tid}/lodging-summary").json()
    assert any(l["lodging_plan"] == "Hotel" and l["players"] == 1 for l in lsum)
    # CVB analytics — cross-tournament stays count.
    cvb = client.get("/api/hotel-analytics").json()
    assert any(h["hotel_name"].lower() == hotel["name"].lower() and h["stays"] >= 1
               for h in cvb)

    # ------------------------------------------------------------------
    # 10. T-shirt order — snapshot today's requested counts.
    # ------------------------------------------------------------------
    tshirt_state = _ok(client.get(f"/api/tournaments/{tid}/tshirt-order"), code=200)
    # Three selected players asked for shirts (Avery YM, Jordan AS, Sam AM).
    requested = {row["size"]: row["requested"] for row in tshirt_state["rows"]}
    assert requested.get("YM", 0) >= 1
    assert requested.get("AS", 0) >= 1
    # Place the order — snapshot fires (returns 200, not 201; idempotent).
    placed = _ok(client.post(f"/api/tournaments/{tid}/tshirt-order"), code=200)
    assert placed["ordered_at"] is not None
    snap = {row["size"]: row["snapshot"] for row in placed["rows"]}
    assert snap.get("YM") is not None

    # ------------------------------------------------------------------
    # 11. Reports — staffing plan with day-by-day grid.
    # ------------------------------------------------------------------
    report = client.get(f"/api/tournaments/{tid}/reports/officials").json()
    assert "totals" in report and "officials" in report
    assert report["totals"]["pay"] >= me["pay"]  # at least our o1's pay
    # o1 should appear with their 3 days + hotel + mileage flag clean.
    o1_row = next(r for r in report["officials"] if r["official_id"] == o1["id"])
    assert len(o1_row["days"]) == 3
    assert o1_row["hotel_name"] == hotel["name"]
    assert o1_row["missing_distance"] is False

    # ------------------------------------------------------------------
    # 12. Optimistic concurrency on Setup → Players (audit M19).
    # ------------------------------------------------------------------
    first = client.get("/api/players").json()
    me_player = next(p for p in first if p["id"] == p1["id"])
    stale_ts = me_player["updated_at"]
    # First PUT with the seen timestamp wins.
    r_ok = client.put(f"/api/players/{p1['id']}", json={
        **me_player, "city": "Atlanta", "state": "GA"
    }, headers={"X-If-Updated-At": stale_ts})
    assert r_ok.status_code == 200
    # Second PUT with the SAME (now-stale) timestamp loses.
    r_409 = client.put(f"/api/players/{p1['id']}", json={
        **me_player, "city": "Macon"
    }, headers={"X-If-Updated-At": stale_ts})
    assert r_409.status_code == 409

    # ------------------------------------------------------------------
    # 13. Final cleanup — every grid we touched still serializes cleanly.
    #     (No assertions on the numbers; just confirms no view/model
    #     drift between the data we wrote and the read endpoints.)
    # ------------------------------------------------------------------
    for path in (
        f"/api/tournaments/{tid}/players",
        f"/api/tournaments/{tid}/late-entries",
        f"/api/tournaments/{tid}/withdrawals",
        f"/api/tournaments/{tid}/scheduling-avoidances",
        f"/api/tournaments/{tid}/division-flex",
        f"/api/tournaments/{tid}/pairing-avoidances",
        f"/api/tournaments/{tid}/doubles",
        f"/api/tournaments/{tid}/player-hotels",
        f"/api/tournaments/{tid}/assignments",
        f"/api/tournaments/{tid}/availability",
        f"/api/tournaments/{tid}/hotel-summary",
        f"/api/tournaments/{tid}/lodging-summary",
        f"/api/tournaments/{tid}/reports/officials",
        f"/api/tournaments/{tid}/tshirt-order",
        f"/api/room-blocks?tournament_id={tid}",
    ):
        r = client.get(path)
        assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"
