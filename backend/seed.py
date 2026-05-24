"""Seed a little demo data (idempotent). Run from backend/:  python seed.py"""
from app.db import get_conn

SITES = [
    {"code": "JDS", "name": "John Drew Smith Tennis Center", "city": "Macon", "state": "GA"},
    {"code": "RSTC", "name": "Rome Tennis Center at Berry College", "city": "Rome", "state": "GA"},
    {"code": "ROME", "name": "Rome Tennis Center", "city": "Rome", "state": "GA"},
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

            for cert, rate in [("roving", 150), ("chair", 200), ("referee", 250)]:
                cur.execute(
                    """
                    INSERT INTO certification_rate (cert_type, rate_per_day)
                    VALUES (%s, %s)
                    ON CONFLICT (cert_type, effective_from) DO NOTHING
                    """,
                    (cert, rate),
                )
        conn.commit()
        print("seed complete")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
