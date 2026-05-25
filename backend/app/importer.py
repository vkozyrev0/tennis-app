"""Spreadsheet import pipeline (audit §3.8).

Uploads are parsed (CSV or XLSX) into canonical rows, written to a staging area
(import_batch / import_row, migration 0020), validated per-row, then merged into
the main tables on confirm. One registry entry per importable data type.
"""
import csv
import io
import re

from openpyxl import Workbook, load_workbook

from .playerops import upsert_player

_VALID_STATUS = {"selected", "alternate", "withdrawn"}

# ---- shared parsing / normalization -----------------------------------------
def _norm(h) -> str:
    return re.sub(r"[^a-z0-9]", "", (str(h) if h is not None else "").strip().lower())


def _s(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


_SHIRT_SIZE = {"s": "Small", "sm": "Small", "small": "Small", "m": "Medium",
               "med": "Medium", "medium": "Medium", "l": "Large", "lg": "Large",
               "large": "Large", "xl": "Extra Large", "xlarge": "Extra Large",
               "extralarge": "Extra Large", "xxl": "Extra Large", "xxxl": "Extra Large"}
_SHIRT_CANON = {f"{g} {s}" for g in ("Youth", "Adult")
                for s in ("Small", "Medium", "Large", "Extra Large")}


def _norm_shirt(v):
    """Map a free-text/abbreviated size to a canonical label; pass through unknowns."""
    if v is None:
        return None
    raw = str(v).strip()
    s = re.sub(r"[^a-z]", "", raw.lower())
    if not s:
        return None
    if s.startswith(("youth", "yth", "junior", "jr")) or (s[:1] == "y" and len(s) <= 4):
        group, rest = "Youth", re.sub(r"^(youth|yth|junior|jr|y)", "", s, count=1)
    elif s.startswith("adult") or (s[:1] == "a" and len(s) <= 4):
        group, rest = "Adult", re.sub(r"^(adult|a)", "", s, count=1)
    else:
        group, rest = "Adult", s
    size = _SHIRT_SIZE.get(rest)
    cand = f"{group} {size}" if size else None
    return cand if cand in _SHIRT_CANON else raw


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
]


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


def validate(data: dict, cols) -> str | None:
    missing = [c.canon for c in cols if c.required and not _s(data.get(c.canon))]
    return ("missing " + ", ".join(missing)) if missing else None


# ---- merge functions (mirror the per-resource routers) ----------------------
def _merge_roster(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"))
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


def _merge_late(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"))
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
    cur.execute(
        "INSERT INTO late_entry (tournament_id, player_id, request_date, request_time, "
        "age_division, events) VALUES (%s,%s,%s,%s,%s,%s)",
        (tid, pid, _s(d.get("request_date")), _s(d.get("request_time")),
         _s(d.get("age_division")), _s(d.get("events"))),
    )


def _merge_withdrawal(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"))
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
        "INSERT INTO withdrawal (tournament_id, player_id, events, reason, notes, was_alternate) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        (tid, pid, _s(d.get("events")), reason, _s(d.get("notes")), was_alt),
    )


def _merge_sched(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"))
    cur.execute(
        "INSERT INTO scheduling_avoidance (tournament_id, player_id, avoid_day, avoid_time_range) "
        "VALUES (%s,%s,%s,%s)",
        (tid, pid, _s(d.get("avoid_day")), _s(d.get("avoid_time_range"))),
    )


def _merge_divflex(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"))
    cur.execute(
        "INSERT INTO division_flexibility (tournament_id, player_id, home_division, willing_divisions) "
        "VALUES (%s,%s,%s,%s)",
        (tid, pid, _s(d.get("home_division")), _s(d.get("willing_divisions"))),
    )


def _merge_photel(cur, tid, d):
    pid = upsert_player(cur, d["usta_number"], d.get("first_name"), d.get("last_name"))
    hotel = " ".join((d.get("hotel_name") or "").split()) or None
    lodging = " ".join((d.get("lodging_plan") or "").split()) or None
    cur.execute(
        "INSERT INTO player_hotel_stay (tournament_id, player_id, hotel_name, lodging_plan) "
        "VALUES (%s,%s,%s,%s)",
        (tid, pid, hotel, lodging),
    )


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
                                        Col("request_time", {"requesttime", "time"})],
                     "merge": _merge_late},
    "withdrawals": {"label": "Withdrawals",
                    "desc": "Players withdrawing (reason required unless they were an alternate).",
                    "cols": _PLAYER + [Col("events", {"event"}), Col("reason"), Col("notes", {"note"})],
                    "merge": _merge_withdrawal},
    "scheduling_avoidances": {"label": "Scheduling avoidances",
                              "desc": "Days/times a player cannot play (adult events).",
                              "cols": _PLAYER + [Col("avoid_day", {"avoidday", "day"}),
                                                 Col("avoid_time_range", {"avoidtime", "time", "timerange"})],
                              "merge": _merge_sched},
    "division_flexibility": {"label": "Division flexibility",
                             "desc": "Players willing to play other divisions.",
                             "cols": _PLAYER + [Col("home_division", {"homedivision", "home", "division"}),
                                                Col("willing_divisions", {"willingdivisions", "willing", "divisions"})],
                             "merge": _merge_divflex},
    "player_hotels": {"label": "Player hotels",
                      "desc": "Each player's reported hotel and lodging plan.",
                      "cols": _PLAYER + [Col("hotel_name", {"hotel", "hotelname"}),
                                         Col("lodging_plan", {"lodging", "lodgingplan", "plan"})],
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
