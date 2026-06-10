"""iCalendar (.ics) export of an official's assignment schedule (RFC 5545).

One all-day VEVENT per assignment day across every tournament. Declined
assignments are skipped; pending ones export as STATUS:TENTATIVE and accepted
as CONFIRMED, so the calendar reflects what the official actually agreed to.
Used by both surfaces: the admin (`GET /api/officials/{id}/schedule.ics`) and
the official's own portal (`GET /api/me/schedule.ics`).
"""
from datetime import datetime, timedelta, timezone

_QUERY = """
SELECT ad.id AS day_id, ad.work_date, ad.working_as, ad.rate_applied,
       a.response_status,
       t.name AS tournament_name,
       s.name AS site_name, s.code AS site_code, s.city AS site_city, s.state AS site_state
FROM assignment_day ad
JOIN assignment a ON a.id = ad.assignment_id
JOIN tournament t ON t.id = a.tournament_id
LEFT JOIN site s ON s.id = a.site_id
WHERE a.official_id = %s AND a.response_status <> 'declined'
ORDER BY ad.work_date, t.name
"""


def _esc(text: str) -> str:
    """RFC 5545 TEXT escaping: backslash, semicolon, comma, newline."""
    return (str(text).replace("\\", "\\\\").replace(";", "\\;")
            .replace(",", "\\,").replace("\n", "\\n"))


def _cert_label(v: str) -> str:
    return str(v).replace("_", " ").capitalize()


def build_schedule_ics(cur, official_id: int) -> str:
    cur.execute(_QUERY, (official_id,))
    rows = cur.fetchall()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//CourtOps Tennis//Schedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]
    for r in rows:
        d = r["work_date"]
        site_bits = [b for b in (r["site_name"], r["site_city"], r["site_state"]) if b]
        summary = f"{r['tournament_name']} — {_cert_label(r['working_as'])}" + (
            f" ({r['site_code'] or r['site_name']})" if (r["site_code"] or r["site_name"]) else "")
        desc = (f"Role: {_cert_label(r['working_as'])} · rate ${float(r['rate_applied']):.2f}/day"
                f" · response: {r['response_status']}")
        lines += [
            "BEGIN:VEVENT",
            f"UID:courtops-day-{r['day_id']}@courtops",
            f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{d.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{(d + timedelta(days=1)).strftime('%Y%m%d')}",
            f"SUMMARY:{_esc(summary)}",
            *( [f"LOCATION:{_esc(', '.join(site_bits))}"] if site_bits else [] ),
            f"DESCRIPTION:{_esc(desc)}",
            f"STATUS:{'CONFIRMED' if r['response_status'] == 'accepted' else 'TENTATIVE'}",
            "TRANSP:OPAQUE",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"   # RFC 5545 mandates CRLF
