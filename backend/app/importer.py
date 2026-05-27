"""Spreadsheet import pipeline (audit §3.8).

Uploads are parsed (CSV or XLSX) into canonical rows, written to a staging area
(import_batch / import_row, migration 0020), validated per-row, then merged into
the main tables on confirm. One registry entry per importable data type.
"""
import csv
import io
import re

from openpyxl import Workbook, load_workbook

from .playerops import upsert_hotel, upsert_player

_VALID_STATUS = {"selected", "alternate", "withdrawn"}

# ---- shared parsing / normalization -----------------------------------------
def _norm(h) -> str:
    return re.sub(r"[^a-z0-9]", "", (str(h) if h is not None else "").strip().lower())


def _s(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


# Shirt-size normalization (audit A51) shared with roster.py via shirtops.py.
from .shirtops import norm_shirt as _norm_shirt


# ---- column model -----------------------------------------------------------
class Col:
    def __init__(self, canon, aliases=(), required=False):
        self.canon = canon
        self.aliases = set(aliases)
        self.required = required


_PLAYER = [
    Col("usta_number", {"ustanumber", "usta", "ustano", "ustaid"}, required=True),
    Col("first_name", {"firstname", "first", "givenname"}),
    Col("last_name", {"lastname", "last", "surname", "familyname"}),
    # Gender is required when the row creates a brand-new player (audit N1).
    # Existing players keep their stored value; the column is treated as
    # optional in `cols` so existing-player imports without it still merge.
    Col("gender", {"gender", "sex", "mf"}),
]


# Audit F14: re-export the shared helper so the existing module-local name
# keeps working without a churn rewrite at every call site.
from .playerops import norm_gender as _norm_gender  # noqa: E402, F401


def _alias_map(cols):
    m = {}
    for c in cols:
        m[c.canon] = c.canon
        for a in c.aliases:
            m[a] = c.canon
    return m


def parse_file(filename: str, raw: bytes, cols) -> list[dict]:
    """Return [{row_num, data:{canon:val}}] for non-empty rows, mapping headers."""
    amap = {_norm(k): v for k, v in _alias_map(cols).items()}
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xlsm")):
        ws = load_workbook(io.BytesIO(raw), data_only=True, read_only=True).active
        it = ws.iter_rows(values_only=True)
        headers = next(it, []) or []
        rows = list(it)
    else:
        text = raw.decode("utf-8-sig", errors="replace")
        reader = csv.reader(io.StringIO(text))
        headers = next(reader, [])
        rows = list(reader)
    cmap = {i: amap[_norm(h)] for i, h in enumerate(headers) if _norm(str(h) if h is not None else "") in amap}
    out = []
    for n, r in enumerate(rows, start=1):
        rec = {canon: _s(r[i]) if i < len(r) else None for i, canon in cmap.items()}
        if any(v not in (None, "") for v in rec.values()):
            out.append({"row_num": n, "data": rec})
    return out


def validate(data: dict, cols, cur) -> str | None:
    """Audit F18: `cur` is now required so a future caller can't accidentally
    skip the staging-time gender check by forgetting to pass it."""
    missing = [c.canon for c in cols if c.required and not _s(data.get(c.canon))]
    if missing:
        return "missing " + ", ".join(missing)
    # Audit T2: surface the gender requirement at *staging* time so the TD
    # sees "30 invalid (missing gender)" before clicking Merge, not after.
    usta = _s(data.get("usta_number"))
    if usta:
        cur.execute("SELECT 1 FROM player WHERE usta_number = %s", (usta,))
        if cur.fetchone() is None and _norm_gender(data.get("gender")) is None:
            return f"player {usta} isn't in Setup yet — gender column is required for new players"
    return None


# ---- merge functions (mirror the per-resource routers) ----------------------
# Each returns a conflict note (str) when the row hit existing data, else None.
# The merge still proceeds ("go with the merge"); the note is surfaced to the user.
def _exists(cur, table, tid, pid) -> bool:
    cur.execute(f"SELECT 1 FROM {table} WHERE tournament_id = %s AND player_id = %s LIMIT 1", (tid, pid))
    return cur.fetchone() is not None


def _merge_roster(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"), _norm_gender(d.get("gender")))
    conflict = ("already on the roster — entry overwritten"
                if _exists(cur, "tournament_entry", tid, pid) else None)
    status = (_s(d.get("selection_status")) or "selected").lower()
    if status not in _VALID_STATUS:
        status = "selected"
    cur.execute(
        """
        INSERT INTO tournament_entry
            (tournament_id, player_id, age_division, events, selection_status,
             t_shirt_size, dietary_preference, source)
        VALUES (%s,%s,%s,%s,%s,%s,%s,'usta_roster')
        ON CONFLICT (tournament_id, player_id) DO UPDATE SET
            age_division = EXCLUDED.age_division, events = EXCLUDED.events,
            selection_status = EXCLUDED.selection_status,
            t_shirt_size = EXCLUDED.t_shirt_size,
            dietary_preference = EXCLUDED.dietary_preference
        """,
        (tid, pid, _s(d.get("age_division")), _s(d.get("events")), status,
         _norm_shirt(_s(d.get("t_shirt_size"))), _s(d.get("dietary_preference"))),
    )
    return conflict


def _merge_late(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"), _norm_gender(d.get("gender")))
    conflict = "already has a late entry — another was added" if _exists(cur, "late_entry", tid, pid) else None
    cur.execute(
        """
        INSERT INTO tournament_entry (tournament_id, player_id, age_division, events,
            selection_status, source)
        VALUES (%s,%s,%s,%s,'selected','late_entry')
        ON CONFLICT (tournament_id, player_id) DO UPDATE SET
            age_division = COALESCE(EXCLUDED.age_division, tournament_entry.age_division),
            events = COALESCE(EXCLUDED.events, tournament_entry.events)
        """,
        (tid, pid, _s(d.get("age_division")), _s(d.get("events"))),
    )
    # Audit F2: preserve source_email_id when the staged import carries it.
    cur.execute(
        "INSERT INTO late_entry (tournament_id, player_id, request_date, request_time, "
        "age_division, events, source_email_id) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (tid, pid, _s(d.get("request_date")), _s(d.get("request_time")),
         _s(d.get("age_division")), _s(d.get("events")),
         _coerce_int(d.get("source_email_id"))),
    )
    return conflict


def _merge_withdrawal(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"), _norm_gender(d.get("gender")))
    conflict = "already has a withdrawal — another was added" if _exists(cur, "withdrawal", tid, pid) else None
    cur.execute("SELECT selection_status FROM tournament_entry "
                "WHERE tournament_id=%s AND player_id=%s", (tid, pid))
    entry = cur.fetchone()
    was_alt = bool(entry and entry["selection_status"] == "alternate")
    reason = _s(d.get("reason"))
    if not was_alt and not reason:
        raise ValueError("a reason is required unless the player was an alternate")
    if entry:
        cur.execute("UPDATE tournament_entry SET selection_status='withdrawn' "
                    "WHERE tournament_id=%s AND player_id=%s", (tid, pid))
    cur.execute(
        "INSERT INTO withdrawal (tournament_id, player_id, events, reason, notes, was_alternate, source_email_id) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (tid, pid, _s(d.get("events")), reason, _s(d.get("notes")), was_alt,
         _coerce_int(d.get("source_email_id"))),
    )
    return conflict


def _merge_sched(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"), _norm_gender(d.get("gender")))
    conflict = "already has a scheduling avoidance — another was added" if _exists(cur, "scheduling_avoidance", tid, pid) else None
    cur.execute(
        "INSERT INTO scheduling_avoidance (tournament_id, player_id, avoid_day, avoid_time_range, source_email_id) "
        "VALUES (%s,%s,%s,%s,%s)",
        (tid, pid, _s(d.get("avoid_day")), _s(d.get("avoid_time_range")),
         _coerce_int(d.get("source_email_id"))),
    )
    return conflict


def _merge_divflex(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"), _norm_gender(d.get("gender")))
    conflict = "already has a division-flexibility entry — another was added" if _exists(cur, "division_flexibility", tid, pid) else None
    cur.execute(
        "INSERT INTO division_flexibility (tournament_id, player_id, home_division, willing_divisions, source_email_id) "
        "VALUES (%s,%s,%s,%s,%s)",
        (tid, pid, _s(d.get("home_division")), _s(d.get("willing_divisions")),
         _coerce_int(d.get("source_email_id"))),
    )
    return conflict


def _merge_pairing(cur, tid, d):
    """Pairing-avoidance group (audit import/export #8). Wide format: one row
    per group, with `usta_1`, `usta_2`, `usta_3?`, `usta_4?` cells. At least
    two non-blank USTAs are required. Players must already exist in Setup."""
    members = []
    for n in range(1, 7):  # support up to 6 members per group
        u = _s(d.get(f"usta_{n}"))
        if u:
            members.append(u)
    if len(members) < 2:
        raise ValueError("pairing-avoidance group needs at least 2 USTA numbers (usta_1..)")
    seen: list[int] = []
    for u in members:
        pid = upsert_player(cur, u, None, None)  # 400 if not in Setup
        if pid not in seen:
            seen.append(pid)
    if len(seen) < 2:
        raise ValueError("pairing-avoidance group needs at least 2 distinct players")
    rel = _s(d.get("relationship"))
    if rel and rel not in ("same_club", "siblings"):
        rel = None
    cur.execute(
        "INSERT INTO pairing_avoidance (tournament_id, age_division, relationship, source_email_id) "
        "VALUES (%s,%s,%s,%s) RETURNING id",
        (tid, _s(d.get("age_division")), rel, _coerce_int(d.get("source_email_id"))),
    )
    gid = cur.fetchone()["id"]
    for pid in seen:
        cur.execute(
            "INSERT INTO pairing_avoidance_member (pairing_avoidance_id, player_id) VALUES (%s,%s)",
            (gid, pid),
        )
    return None


def _merge_doubles(cur, tid, d):
    """Doubles request (audit import/export #9). One row per request; mutual
    verification fires naturally when both sides land in the batch. Players
    must already exist in Setup AND on the tournament roster."""
    usta = _s(d.get("usta_number"))
    if not usta:
        raise ValueError("usta_number is required")
    pid = upsert_player(cur, usta, _s(d.get("first_name")), _s(d.get("last_name")))
    wants_random = str(d.get("wants_random") or "").strip().lower() in ("1", "true", "yes", "y", "random")
    partner = _s(d.get("partner_usta"))
    if not wants_random and not partner:
        raise ValueError("doubles request needs a partner_usta (or set wants_random=true)")
    if partner and partner == usta:
        raise ValueError("partner_usta cannot equal the requester's own USTA #")
    division = _s(d.get("age_division"))
    if wants_random and not division:
        raise ValueError("random doubles request needs an age_division")
    conflict = None
    cur.execute(
        "SELECT 1 FROM doubles_request WHERE tournament_id = %s AND player_id = %s",
        (tid, pid),
    )
    if cur.fetchone():
        conflict = "player already has a doubles request — another was added"
    cur.execute(
        "INSERT INTO doubles_request (tournament_id, player_id, age_division, "
        "wants_random, partner_usta, source_email_id, status) "
        "VALUES (%s,%s,%s,%s,%s,%s,'pending')",
        (tid, pid, division, wants_random, partner, _coerce_int(d.get("source_email_id"))),
    )
    return conflict


def _merge_distance(cur, tid, d):
    """Setup-catalog importer: official↔site distance (audit import/export #7).

    `tid` is unused — distances are a Setup catalog, not per-tournament.
    Identifies official + site by id (preferred) or by label lookup:
      - official: (last_name, first_name)
      - site: code, then name
    Inserts new rows or updates the existing (official, site) pair.
    """
    miles = _s(d.get("one_way_miles"))
    if miles is None:
        raise ValueError("one_way_miles is required")
    try:
        miles_f = float(miles)
    except (TypeError, ValueError):
        raise ValueError(f"one_way_miles must be numeric, got {miles!r}")
    # Resolve official.
    oid = _coerce_int(d.get("official_id"))
    if oid is None:
        first, last = _s(d.get("first_name")), _s(d.get("last_name"))
        if not last:
            raise ValueError("official_id or (first_name, last_name) is required")
        if first:
            cur.execute(
                "SELECT id FROM official WHERE lower(last_name) = lower(%s) "
                "AND lower(first_name) = lower(%s)",
                (last, first),
            )
        else:
            cur.execute(
                "SELECT id FROM official WHERE lower(last_name) = lower(%s)",
                (last,),
            )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"official {first or ''} {last} not found")
        oid = row["id"]
    # Resolve site.
    sid = _coerce_int(d.get("site_id"))
    if sid is None:
        code, name = _s(d.get("site_code")), _s(d.get("site_name"))
        if code:
            cur.execute("SELECT id FROM site WHERE code = %s", (code,))
            row = cur.fetchone()
        elif name:
            cur.execute("SELECT id FROM site WHERE lower(name) = lower(%s)", (name,))
            row = cur.fetchone()
        else:
            raise ValueError("site_id, site_code, or site_name is required")
        if row is None:
            raise ValueError(f"site {code or name} not found")
        sid = row["id"]
    source = _s(d.get("source")) or "manual"
    if source not in ("manual", "geocoded"):
        source = "manual"
    cur.execute("SELECT id FROM official_site_distance WHERE official_id = %s AND site_id = %s", (oid, sid))
    existing = cur.fetchone()
    conflict = None
    if existing:
        cur.execute(
            "UPDATE official_site_distance SET one_way_miles = %s, source = %s WHERE id = %s",
            (miles_f, source, existing["id"]),
        )
        conflict = "distance already on file — overwritten"
    else:
        cur.execute(
            "INSERT INTO official_site_distance (official_id, site_id, one_way_miles, source) "
            "VALUES (%s, %s, %s, %s)",
            (oid, sid, miles_f, source),
        )
    return conflict


def _merge_photel(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"), _norm_gender(d.get("gender")))
    conflict = "already has a hotel on file — another was added" if _exists(cur, "player_hotel_stay", tid, pid) else None
    hid, hname = upsert_hotel(cur, d.get("hotel_name"))
    lodging = " ".join((d.get("lodging_plan") or "").split()) or None
    cur.execute(
        "INSERT INTO player_hotel_stay (tournament_id, player_id, hotel_id, hotel_name, lodging_plan, source_email_id) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        (tid, pid, hid, hname, lodging,
         _coerce_int(d.get("source_email_id"))),
    )
    return conflict


def _coerce_int(v):
    """Best-effort int coercion for staged-import values (CSV gives strings)."""
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# Audit F2: optional column accepted by every Part-B importer so a staged CSV
# can preserve the originating email's id when it's known. Blank = no source.
_SRC_EMAIL = Col("source_email_id", {"sourceemailid", "emailid", "source"})


# ---- registry ---------------------------------------------------------------
TYPES = {
    "roster": {"label": "Roster",
               "desc": "Players entered for the tournament (division, status, t-shirt, dietary).",
               "cols": _PLAYER + [Col("age_division", {"division", "div", "age"}),
                                  Col("events", {"event"}),
                                  Col("selection_status", {"status", "selection"}),
                                  Col("t_shirt_size", {"tshirt", "shirt", "shirtsize", "size", "tshirtsize"}),
                                  Col("dietary_preference", {"dietary", "diet", "dietaryrestrictions"})],
               "merge": _merge_roster},
    "late_entries": {"label": "Late entries",
                     "desc": "Players entering after the deadline; also added to the roster.",
                     "cols": _PLAYER + [Col("age_division", {"division", "div"}),
                                        Col("events", {"event"}),
                                        Col("request_date", {"requestdate", "date"}),
                                        Col("request_time", {"requesttime", "time"}),
                                        _SRC_EMAIL],
                     "merge": _merge_late},
    "withdrawals": {"label": "Withdrawals",
                    "desc": "Players withdrawing (reason required unless they were an alternate).",
                    "cols": _PLAYER + [Col("events", {"event"}), Col("reason"), Col("notes", {"note"}), _SRC_EMAIL],
                    "merge": _merge_withdrawal},
    "scheduling_avoidances": {"label": "Scheduling avoidances",
                              "desc": "Days/times a player cannot play (adult events).",
                              "cols": _PLAYER + [Col("avoid_day", {"avoidday", "day"}),
                                                 Col("avoid_time_range", {"avoidtime", "time", "timerange"}),
                                                 _SRC_EMAIL],
                              "merge": _merge_sched},
    "division_flexibility": {"label": "Division flexibility",
                             "desc": "Players willing to play other divisions.",
                             "cols": _PLAYER + [Col("home_division", {"homedivision", "home", "division"}),
                                                Col("willing_divisions", {"willingdivisions", "willing", "divisions"}),
                                                _SRC_EMAIL],
                             "merge": _merge_divflex},
    "pairing_avoidances": {"label": "Pairing avoidances",
                           "desc": "2+ players who must not meet in round 1 (siblings / same club). Wide format: usta_1, usta_2, [usta_3..].",
                           "cols": [
                               Col("usta_1", {"usta1"}, required=True),
                               Col("usta_2", {"usta2"}, required=True),
                               Col("usta_3", {"usta3"}),
                               Col("usta_4", {"usta4"}),
                               Col("usta_5", {"usta5"}),
                               Col("usta_6", {"usta6"}),
                               Col("age_division", {"division", "div"}),
                               Col("relationship", {"rel"}),
                               _SRC_EMAIL,
                           ],
                           "merge": _merge_pairing},
    "doubles_requests": {"label": "Doubles requests",
                         "desc": "Per-player request; mutual sides pair automatically when both rows land in the batch.",
                         "cols": _PLAYER + [Col("age_division", {"division", "div"}),
                                            Col("wants_random", {"random"}),
                                            Col("partner_usta", {"partnerusta", "partner"}),
                                            _SRC_EMAIL],
                         "merge": _merge_doubles},
    # Setup-catalog importer (audit import/export #7). Not per-tournament.
    "distances": {"label": "Distances (Setup catalog)",
                  "desc": "Official↔site one-way mileage. Match by ids OR by labels (last/first + site code/name).",
                  "cols": [
                      Col("official_id", {"officialid"}),
                      Col("first_name", {"firstname", "first"}),
                      Col("last_name", {"lastname", "last", "surname"}),
                      Col("site_id", {"siteid"}),
                      Col("site_code", {"sitecode", "code"}),
                      Col("site_name", {"sitename", "site"}),
                      Col("one_way_miles", {"miles", "onewaymiles"}, required=True),
                      Col("source", {"src"}),
                  ],
                  "merge": _merge_distance},
    "player_hotels": {"label": "Player hotels",
                      "desc": "Each player's reported hotel and lodging plan.",
                      "cols": _PLAYER + [Col("hotel_name", {"hotel", "hotelname"}),
                                         Col("lodging_plan", {"lodging", "lodgingplan", "plan"}),
                                         _SRC_EMAIL],
                      "merge": _merge_photel},
}


def types_meta():
    return [{"key": k, "label": t["label"], "desc": t["desc"],
             "columns": [c.canon for c in t["cols"]],
             "required": [c.canon for c in t["cols"] if c.required]}
            for k, t in TYPES.items()]


# ---- template files ---------------------------------------------------------
def template_csv(key) -> bytes:
    headers = [c.canon for c in TYPES[key]["cols"]]
    buf = io.StringIO()
    csv.writer(buf).writerow(headers)
    return buf.getvalue().encode("utf-8-sig")


def template_xlsx(key) -> bytes:
    headers = [c.canon for c in TYPES[key]["cols"]]
    wb = Workbook()
    wb.active.append(headers)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
