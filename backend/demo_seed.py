"""Build a rich, coherent, *live* demo tournament and load it into the working DB.

Wipes everything (via reset_demo → schema-safe truncate + the lean baseline seed)
then layers a believable, in-progress Middle-Georgia USTA junior event:

  • two real venues in Macon + a Rome event, a hotel + an officials' room block
  • a 7-person officiating crew with certifications, logins, availability, and
    plausible home-city → venue mileage
  • the full 32-player junior roster entered with age divisions, shirt sizes and
    a few alternates (a couple left intentionally incomplete)
  • assignments with per-day roles across both venues, a realistic accept /
    decline / pending response mix, one over-the-road official in the hotel block,
    one with a missing mileage distance, one assigned without a login, and a
    genuine cross-tournament double-booking to resolve
  • an inbox of unfiled parent emails (a withdrawal, a late entry, a doubles
    request, plus two unmatched questions), some days old

so every screen — dashboard, readiness, roster, staffing, reports, inbox — opens
to lifelike activity. Dates are relative to today, so deadlines stay meaningful.

Run from backend/:   python demo_seed.py
"""
from datetime import date, timedelta

import reset_demo
from app.crypto import encrypt as _enc_body
from app.db import get_conn

TODAY = date.today()
T1_START = TODAY + timedelta(days=12)            # main event starts in ~2 weeks
T1_DAYS = [T1_START + timedelta(days=i) for i in range(4)]   # 4-day event
T2_START = T1_START                              # overlaps day 1 (for the clash)
T2_DAYS = [T2_START + timedelta(days=i) for i in range(2)]

CONFIRMATION = "MCN4QX7"

# Macon-area venue added on top of the seeded John Drew Smith Tennis Center.
EXTRA_SITE = {"code": "MERC", "name": "Mercer University Tennis Complex",
              "city": "Macon", "state": "GA"}

# The officiating crew. (home_city, one-way miles to the Macon venues, certs,
# dietary, demo login username|None). Distances are plausible for the region.
CREW = [
    # first,      last,         city,            miles, certs,                                  diet,          login
    ("James",     "Whitfield",  "Macon",            4,  ("chair_umpire", "tournament_referee"), None,          "jwhitfield"),
    ("Robert",    "Hayes",      "Warner Robins",   18,  ("chair_umpire",),                      None,          "rhayes"),
    ("Carmen",    "Delgado",    "Atlanta",         84,  ("roving_official",),                   None,          "cdelgado"),
    ("Tanya",     "Brooks",     "Macon",            7,  ("roving_official",),                   "Vegetarian",  "tbrooks"),
    ("David",     "Okonkwo",    "Atlanta",         83,  ("chair_umpire",),                      "Gluten-free", "dokonkwo"),
    ("Susan",     "Park",       "Marietta",        None, ("roving_official",),                  None,          None),   # no distance, no login
    ("Michael",   "Carrington", "Macon",            5,  ("chair_umpire", "roving_official"),    None,          "mcarrington"),
]


def _division(gender, birth_year):
    age = T1_START.year - int(birth_year)
    bucket = 12 if age <= 12 else 14 if age <= 14 else 16 if age <= 16 else 18
    return ("G" if gender == "female" else "B") + str(bucket)


SHIRTS = ["Youth Small", "Youth Medium", "Youth Large", "Adult Small", "Adult Medium", "Adult Large"]


def main():
    reset_demo.main()   # wipe + lean baseline (sites, 32 players, cert rates, admin)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            ins = lambda sql, args=(): (cur.execute(sql, args), cur.fetchone())[1]

            # Drop the lean baseline's empty placeholder tournament so the demo
            # shows only fully-populated events (no sparse shell).
            cur.execute("DELETE FROM tournament_site WHERE tournament_id IN "
                        "(SELECT id FROM tournament WHERE name = 'Spring Junior Open 2026')")
            cur.execute("DELETE FROM tournament WHERE name = 'Spring Junior Open 2026'")

            # ---- venues -----------------------------------------------------
            cur.execute("INSERT INTO site (code, name, city, state) VALUES "
                        "(%(code)s,%(name)s,%(city)s,%(state)s) ON CONFLICT (code) DO NOTHING",
                        EXTRA_SITE)
            cur.execute("SELECT code, id FROM site")
            site = {r["code"]: r["id"] for r in cur.fetchall()}
            jds, merc, rome = site["JDS"], site["MERC"], site["RSTC"]

            # ---- the two tournaments ---------------------------------------
            t1 = ins(
                "INSERT INTO tournament (name,type,play_start_date,play_end_date,"
                "registration_deadline,late_entry_deadline) VALUES (%s,'junior',%s,%s,%s,%s) "
                "RETURNING id",
                ("Macon Junior Open 2026", T1_START, T1_DAYS[-1],
                 TODAY + timedelta(days=3), TODAY + timedelta(days=6)))["id"]
            for sid in (jds, merc):
                cur.execute("INSERT INTO tournament_site (tournament_id,site_id) VALUES (%s,%s) "
                            "ON CONFLICT DO NOTHING", (t1, sid))
            t2 = ins(
                "INSERT INTO tournament (name,type,play_start_date,play_end_date,"
                "registration_deadline,late_entry_deadline) VALUES (%s,'junior',%s,%s,%s,%s) "
                "RETURNING id",
                ("Rome Junior Classic 2026", T2_START, T2_DAYS[-1],
                 TODAY + timedelta(days=2), TODAY + timedelta(days=5)))["id"]
            cur.execute("INSERT INTO tournament_site (tournament_id,site_id) VALUES (%s,%s) "
                        "ON CONFLICT DO NOTHING", (t2, rome))

            # ---- hotel + officials' room block -----------------------------
            hotel = ins("INSERT INTO hotel (name) VALUES (%s) RETURNING id",
                        ("Courtyard by Marriott Macon",))["id"]
            block = ins(
                "INSERT INTO room_block (hotel_id,tournament_id,kind,confirmation_number,"
                "check_in,check_out,room_count) VALUES (%s,%s,'official',%s,%s,%s,4) RETURNING id",
                (hotel, t1, CONFIRMATION, T1_DAYS[0], T1_DAYS[-1]))["id"]

            # ---- per-day certification rates (for pay) ---------------------
            cur.execute("SELECT DISTINCT ON (cert_type) cert_type, rate_per_day "
                        "FROM certification_rate ORDER BY cert_type, effective_from DESC")
            rate = {r["cert_type"]: float(r["rate_per_day"]) for r in cur.fetchall()}

            # ---- the officiating crew --------------------------------------
            from app.security import hash_pw
            crew = {}
            for first, last, city, miles, certs, diet, uname in CREW:
                oid = ins("INSERT INTO official (first_name,last_name,email,city,state,"
                          "dietary_restrictions) VALUES (%s,%s,%s,%s,'GA',%s) RETURNING id",
                          (first, last, f"{first.lower()}.{last.lower()}@example.com",
                           city, diet))["id"]
                for ct in certs:
                    cur.execute("INSERT INTO certification (official_id,cert_type) VALUES (%s,%s) "
                                "ON CONFLICT DO NOTHING", (oid, ct))
                if uname:
                    cur.execute("INSERT INTO user_account (username,password_hash,role,official_id) "
                                "VALUES (%s,%s,'official',%s) ON CONFLICT (username) DO NOTHING",
                                (uname, hash_pw("official"), oid))
                crew[last] = {"id": oid, "miles": miles}

            # ---- roster: enter all 32 players (a few alternates / incomplete)
            cur.execute("SELECT id,usta_number,gender,birthdate FROM player ORDER BY usta_number")
            players = cur.fetchall()
            for i, p in enumerate(players):
                div = _division(p["gender"], str(p["birthdate"])[:4])
                status = "alternate" if i % 9 == 8 else "selected"          # ~1 in 9 alternate
                shirt = None if i in (3, 17) else SHIRTS[i % len(SHIRTS)]    # 2 left incomplete
                cur.execute(
                    "INSERT INTO tournament_entry (tournament_id,player_id,age_division,"
                    "selection_status,t_shirt_size,source) VALUES (%s,%s,%s,%s,%s,'manual') "
                    "ON CONFLICT (tournament_id,player_id) DO NOTHING",
                    (t1, p["id"], div, status, shirt))
            by_usta = {p["usta_number"]: p for p in players}

            # a lighter roster for the Rome event (kids often play several events)
            for p in players[:10]:
                div = _division(p["gender"], str(p["birthdate"])[:4])
                cur.execute(
                    "INSERT INTO tournament_entry (tournament_id,player_id,age_division,"
                    "selection_status,source) VALUES (%s,%s,%s,'selected','manual') "
                    "ON CONFLICT (tournament_id,player_id) DO NOTHING",
                    (t2, p["id"], div))

            # ---- availability (within the play window) ---------------------
            iso = [d.isoformat() for d in T1_DAYS]
            avail = {"Whitfield": iso, "Hayes": iso, "Delgado": iso[:2],
                     "Brooks": iso, "Okonkwo": iso[1:], "Park": iso[:1], "Carrington": iso[:2]}
            for last, dates in avail.items():
                for d in dates:
                    cur.execute("INSERT INTO availability (official_id,tournament_id,"
                                "available_date,hotel_needed) VALUES (%s,%s,%s,%s)",
                                (crew[last]["id"], t1, d, last in ("Okonkwo", "Park")))

            # ---- mileage distances (Park left without one on purpose) ------
            site_for = {"Whitfield": jds, "Hayes": merc, "Delgado": jds, "Brooks": merc,
                        "Okonkwo": jds, "Carrington": jds}
            for last, sid in site_for.items():
                if crew[last]["miles"] is not None:
                    cur.execute("INSERT INTO official_site_distance (official_id,site_id,"
                                "one_way_miles,source) VALUES (%s,%s,%s,'manual') "
                                "ON CONFLICT (official_id,site_id) DO NOTHING",
                                (crew[last]["id"], sid, crew[last]["miles"]))

            # ---- assignments + worked days + a realistic response mix ------
            def assign(last, sid, role, day_idxs, status, room=False):
                aid = ins("INSERT INTO assignment (tournament_id,official_id,site_id,room_block_id,"
                          "response_status,responded_at) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                          (t1, crew[last]["id"], sid, block if room else None, status,
                           None if status == "pending" else TODAY))["id"]
                for di in day_idxs:
                    cur.execute("INSERT INTO assignment_day (assignment_id,work_date,working_as,"
                                "rate_applied) VALUES (%s,%s,%s,%s)",
                                (aid, T1_DAYS[di], role, rate.get(role, 0)))
                return aid

            assign("Whitfield", jds, "chair_umpire", [0, 1, 2], "accepted")        # local → free-band mileage
            assign("Hayes", merc, "chair_umpire", [0, 1, 2, 3], "accepted")
            assign("Delgado", jds, "roving_official", [0, 1], "pending")
            assign("Brooks", merc, "roving_official", [1, 2, 3], "declined")        # → declined alert
            assign("Okonkwo", jds, "chair_umpire", [1, 2, 3], "accepted", room=True)
            assign("Park", jds, "roving_official", [0], "pending", room=True)       # no distance, no login
            a_carr = assign("Carrington", jds, "chair_umpire", [0], "pending")      # day-1 chair at JDS

            # cross-tournament double-booking: Carrington also works Rome on the
            # SAME day → a hard conflict (different venue) for the TD to catch.
            a_carr2 = ins("INSERT INTO assignment (tournament_id,official_id,site_id,response_status) "
                          "VALUES (%s,%s,%s,'pending') RETURNING id",
                          (t2, crew["Carrington"]["id"], rome))["id"]
            cur.execute("INSERT INTO assignment_day (assignment_id,work_date,working_as,rate_applied) "
                        "VALUES (%s,%s,'chair_umpire',%s)", (a_carr2, T2_DAYS[0], rate["chair_umpire"]))

            # ---- inbox: unfiled parent emails (some days old) --------------
            def email(subject, sender, body, days_ago, classification=None, usta=None):
                pid = by_usta[usta]["id"] if usta and usta in by_usta else None
                cur.execute(
                    "INSERT INTO email_message (tournament_id,from_address,subject,body,"
                    "classification,status,detected_player_id,detected_match_kind,"
                    "detected_usta_text,received_at) VALUES (%s,%s,%s,%s,%s,'new',%s,%s,%s,"
                    "now() - make_interval(days => %s))",
                    (t1, sender, subject, _enc_body(body), classification or "unclassified",
                     pid, "usta" if pid else None, usta, days_ago))

            email("Withdrawal — Sophia Chen", "rebecca.chen@example.com",
                  "Hi, unfortunately Sophia Chen (USTA 21215067) has to withdraw from the Macon "
                  "Junior Open — she sprained her ankle at practice. Thank you, Rebecca Chen.",
                  4, "withdrawal", "21215067")
            email("Late entry request — Ethan Carter", "marcus.carter@example.com",
                  "Is it too late to enter Ethan Carter, USTA 21043871, in the boys' 16s? We just "
                  "missed the registration deadline. Thanks!", 2, "late_entry", "21043871")
            email("Doubles partner for Mia?", "linda.nguyen@example.com",
                  "Mia Nguyen (USTA 21268106) is hoping to find a doubles partner for the event "
                  "if anyone is still looking.", 1, "doubles", "21268106")
            email("Officials' hotel block?", "frontdesk@maconcourtyard.example.com",
                  "Following up on the room block for tournament officials — can you confirm the "
                  "final headcount by Friday?", 1)
            email("Gate times on finals day", "info@maconjuniortennis.example.com",
                  "What time do the gates open on finals day? A few parents have asked.", 3)

        conn.commit()
        print(f"demo ready · {len(CREW)} officials · 2 tournaments "
              f"(“Macon Junior Open 2026” fully staffed) · 32-player roster · live inbox")
        print(f"  Macon Junior Open plays {T1_DAYS[0]}…{T1_DAYS[-1]}; "
              f"official logins use password 'official' (e.g. jwhitfield, rhayes, cdelgado)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
