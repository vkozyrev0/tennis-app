"""Seed a little demo data (idempotent). Run from backend/:  python seed.py"""
import os

from app.db import get_conn
from app.security import hash_pw

SITES = [
    {"code": "JDS", "name": "John Drew Smith Tennis Center", "city": "Macon", "state": "GA"},
    {"code": "RSTC", "name": "Rome Tennis Center at Berry College", "city": "Rome", "state": "GA"},
    {"code": "ROME", "name": "Rome Tennis Center", "city": "Rome", "state": "GA"},
]

# A realistic-looking junior roster (16 boys + 16 girls) so demos exercise the
# gender-aware division/event filters. USTA numbers are 8-digit placeholders.
PLAYERS = [
    # ---- Boys ----
    ("21043871", "Ethan",     "Carter",    "male",   "2010-04-12", "Atlanta",   "GA"),
    ("21059234", "Liam",      "Anderson",  "male",   "2008-08-23", "Macon",     "GA"),
    ("21071486", "Noah",      "Williams",  "male",   "2007-02-09", "Augusta",   "GA"),
    ("21082957", "Mason",     "Thompson",  "male",   "2013-11-30", "Savannah",  "GA"),
    ("21094612", "Lucas",     "Martinez",  "male",   "2010-07-18", "Athens",    "GA"),
    ("21107385", "Oliver",    "Brown",     "male",   "2008-05-04", "Columbus",  "GA"),
    ("21118049", "James",     "Davis",     "male",   "2007-09-27", "Marietta",  "GA"),
    ("21126731", "Benjamin",  "Garcia",    "male",   "2013-03-15", "Roswell",   "GA"),
    ("21134298", "Henry",     "Wilson",    "male",   "2010-12-08", "Alpharetta","GA"),
    ("21148563", "Alexander", "Lee",       "male",   "2008-06-21", "Decatur",   "GA"),
    ("21157214", "Daniel",    "Robinson",  "male",   "2007-10-11", "Sandy Springs", "GA"),
    ("21163987", "Matthew",   "Walker",    "male",   "2013-01-25", "Johns Creek","GA"),
    ("21171258", "Jackson",   "Hall",      "male",   "2010-09-03", "Duluth",    "GA"),
    ("21185490", "Aiden",     "Young",     "male",   "2008-04-17", "Kennesaw",  "GA"),
    ("21196372", "Caleb",     "Wright",    "male",   "2007-07-29", "Smyrna",    "GA"),
    ("21204815", "Owen",      "Patel",     "male",   "2013-10-06", "Suwanee",   "GA"),
    # ---- Girls ----
    ("21215067", "Sophia",    "Chen",      "female", "2010-03-22", "Atlanta",   "GA"),
    ("21223941", "Olivia",    "Mitchell",  "female", "2008-08-11", "Macon",     "GA"),
    ("21238275", "Emma",      "Rodriguez", "female", "2007-01-30", "Augusta",   "GA"),
    ("21246158", "Ava",       "Johnson",   "female", "2013-12-04", "Savannah",  "GA"),
    ("21257423", "Isabella",  "Kim",       "female", "2010-06-19", "Athens",    "GA"),
    ("21268106", "Mia",       "Nguyen",    "female", "2008-04-08", "Columbus",  "GA"),
    ("21274891", "Charlotte", "Adams",     "female", "2007-11-15", "Marietta",  "GA"),
    ("21283659", "Amelia",    "Clark",     "female", "2013-05-26", "Roswell",   "GA"),
    ("21295174", "Harper",    "Lewis",     "female", "2010-10-02", "Alpharetta","GA"),
    ("21307842", "Evelyn",    "Scott",     "female", "2008-07-13", "Decatur",   "GA"),
    ("21318296", "Abigail",   "Turner",    "female", "2007-03-24", "Sandy Springs", "GA"),
    ("21326710", "Ella",      "Phillips",  "female", "2013-09-09", "Johns Creek","GA"),
    ("21334987", "Lily",      "Campbell",  "female", "2010-02-28", "Duluth",    "GA"),
    ("21349153", "Grace",     "Sullivan",  "female", "2008-11-05", "Kennesaw",  "GA"),
    ("21356428", "Chloe",     "Rivera",    "female", "2007-05-17", "Smyrna",    "GA"),
    ("21368790", "Zoey",      "Foster",    "female", "2013-08-21", "Suwanee",   "GA"),
]

TOURNAMENT = {
    "name": "Spring Junior Open 2026",
    "type": "junior",
    "play_start_date": "2026-06-01",
    "play_end_date": "2026-06-04",
    "registration_deadline": "2026-05-20",
    "late_entry_deadline": "2026-05-28",
    "site_code": "JDS",
}


def main() -> None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            for s in SITES:
                cur.execute(
                    """
                    INSERT INTO site (code, name, city, state)
                    VALUES (%(code)s, %(name)s, %(city)s, %(state)s)
                    ON CONFLICT (code) DO NOTHING
                    """,
                    s,
                )
            cur.execute(
                "SELECT id FROM site WHERE code = %s", (TOURNAMENT["site_code"],)
            )
            site_id = cur.fetchone()["id"]
            cur.execute(
                """
                INSERT INTO tournament
                    (name, type, play_start_date, play_end_date,
                     registration_deadline, late_entry_deadline)
                VALUES
                    (%(name)s, %(type)s, %(play_start_date)s, %(play_end_date)s,
                     %(registration_deadline)s, %(late_entry_deadline)s)
                ON CONFLICT (name) DO NOTHING
                """,
                TOURNAMENT,
            )
            cur.execute("SELECT id FROM tournament WHERE name = %s", (TOURNAMENT["name"],))
            tournament_id = cur.fetchone()["id"]
            cur.execute(
                """
                INSERT INTO tournament_site (tournament_id, site_id)
                VALUES (%s, %s) ON CONFLICT DO NOTHING
                """,
                (tournament_id, site_id),
            )

            for cert, rate in [("roving_official", 150), ("chair_umpire", 200),
                               ("tournament_referee", 250)]:
                cur.execute(
                    """
                    INSERT INTO certification_rate (cert_type, rate_per_day)
                    VALUES (%s, %s)
                    ON CONFLICT (cert_type, effective_from) DO NOTHING
                    """,
                    (cert, rate),
                )

            # Demo player roster: realistic-looking names + USTA #s split evenly
            # boys/girls so the gender-aware division/event pickers have data to
            # work with. Idempotent on usta_number; updates name/gender/etc. so
            # re-seeding after a model change refreshes the rows.
            for p in PLAYERS:
                cur.execute(
                    """
                    INSERT INTO player (usta_number, first_name, last_name,
                                        gender, birthdate, city, state)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (usta_number) DO UPDATE SET
                        first_name = EXCLUDED.first_name,
                        last_name  = EXCLUDED.last_name,
                        gender     = EXCLUDED.gender,
                        birthdate  = EXCLUDED.birthdate,
                        city       = EXCLUDED.city,
                        state      = EXCLUDED.state
                    """,
                    p,
                )

            # Best-effort cleanup of leftover fixture players from earlier dev
            # iterations: anyone with a non-numeric USTA # (real USTA #s are all
            # digits) plus the obvious "test"/"player"/"doe" name patterns. We
            # cascade through every child table so the player rows can actually
            # go away (roster, late entry, withdrawal, hotel, scheduling, etc.).
            cur.execute("SAVEPOINT cleanup_test_players")
            try:
                cur.execute(
                    """
                    CREATE TEMP TABLE _stale_players ON COMMIT DROP AS
                    SELECT id FROM player
                     WHERE first_name ILIKE 'test%%' OR last_name ILIKE 'test%%'
                        OR first_name ILIKE 'player%%' OR last_name ILIKE 'doe'
                        -- Real USTA #s are all digits; placeholders are fixtures.
                        -- We do NOT include NULL-name / NULL-birthdate here:
                        -- roster-inline-create and inbox upserts legitimately
                        -- leave those NULL until the TD fills them in (N2).
                        OR usta_number !~ '^[0-9]+$'
                    """
                )
                # Tables that reference player.id directly. Order matters only
                # where one child references another (none do here).
                for tbl in ("tournament_entry", "late_entry", "withdrawal",
                            "player_hotel_stay", "scheduling_avoidance",
                            "division_flexibility", "doubles_request",
                            "pairing_avoidance_member"):
                    cur.execute(
                        "SAVEPOINT s_" + tbl)
                    try:
                        cur.execute(
                            f"DELETE FROM {tbl} WHERE player_id IN (SELECT id FROM _stale_players)"
                        )
                        cur.execute("RELEASE SAVEPOINT s_" + tbl)
                    except Exception:  # table may not exist on older schemas
                        cur.execute("ROLLBACK TO SAVEPOINT s_" + tbl)
                # doubles_pair references two player ids
                cur.execute("SAVEPOINT s_pair")
                try:
                    cur.execute(
                        "DELETE FROM doubles_pair WHERE player1_id IN (SELECT id FROM _stale_players)"
                        " OR player2_id IN (SELECT id FROM _stale_players)"
                    )
                    cur.execute("RELEASE SAVEPOINT s_pair")
                except Exception:
                    cur.execute("ROLLBACK TO SAVEPOINT s_pair")
                cur.execute("DELETE FROM player WHERE id IN (SELECT id FROM _stale_players)")
                cur.execute("RELEASE SAVEPOINT cleanup_test_players")
            except Exception:  # leave the db alone on any unexpected schema diff
                cur.execute("ROLLBACK TO SAVEPOINT cleanup_test_players")

            # Admin login. Defaults to admin/admin for the POC (must_change_password
            # so ENV=prod forces rotation — audit D3). Set ADMIN_PASSWORD to harden
            # a real deployment (overwrites hash + clears the force-change flag).
            admin_pw = os.environ.get("ADMIN_PASSWORD")
            if admin_pw:
                cur.execute(
                    "INSERT INTO user_account (username, password_hash, role, "
                    "  must_change_password) "
                    "VALUES ('admin', %s, 'admin', false) "
                    "ON CONFLICT (username) DO UPDATE SET "
                    "  password_hash = EXCLUDED.password_hash, "
                    "  must_change_password = false",
                    (hash_pw(admin_pw),),
                )
            else:
                cur.execute(
                    "INSERT INTO user_account (username, password_hash, role, "
                    "  must_change_password) "
                    "VALUES ('admin', %s, 'admin', true) "
                    "ON CONFLICT (username) DO NOTHING",
                    (hash_pw("admin"),),
                )
        conn.commit()
        print("seed complete")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
