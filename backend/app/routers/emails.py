"""Part B review inbox: inbound parent/player email, filed by a human (D5/§5.1)."""
import re

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..crypto import decrypt as _dec_body
from ..crypto import encrypt as _enc_body
from ..db import db_dep
from ..email_targets import (
    POPULATE_TARGETS,
    SINGLE_FILE_ONLY_KEYS,
    public_targets,
)
from ..models import (
    EmailAmend,
    EmailBulkDetect,
    EmailBulkPopulate,
    EmailBulkReassign,
    EmailCreate,
    EmailDetectResult,
    EmailOut,
    EmailUpdate,
)
from ..triage import classify

router = APIRouter(prefix="/api/emails", tags=["emails"])

# SELECT joins LEFT to player so detected_player_name + detected_usta render
# inline in the inbox grid alongside the classification.
_COLS = (
    "e.id, e.tournament_id, e.message_id, e.received_at, e.from_address, "
    "e.subject, e.body, e.classification, e.status, e.detected_player_id, "
    "e.detected_match_kind, e.detected_usta_text, "
    "p.usta_number AS detected_usta, "
    "TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) "
    "  AS detected_player_name, "
    "tn.name AS tournament_name, "
    # Amendment lineage: what this email corrects (am.subject) and whether a
    # later email corrects THIS one (superseded → the filed row may be stale).
    "e.amends_email_id, am.subject AS amends_subject, "
    "EXISTS (SELECT 1 FROM email_message s WHERE s.amends_email_id = e.id) AS superseded"
)
_FROM = ("FROM email_message e "
         "LEFT JOIN player p ON p.id = e.detected_player_id "
         "LEFT JOIN tournament tn ON tn.id = e.tournament_id "
         "LEFT JOIN email_message am ON am.id = e.amends_email_id")


@router.get("", response_model=list[EmailOut])
def list_emails(response: Response, tournament_id: int | None = None,
                status: str | None = None, q: str | None = None,
                limit: int | None = None, offset: int = 0, conn=Depends(db_dep)):
    """Server-side filtered/paged inbox. `q` searches subject + from_address +
    the player's USTA # (matched player's number AND the USTA # parsed from the
    email text) — but NOT the body itself, which is encrypted at rest (H2).
    `limit`/`offset` page the result; the full match count is in the
    `X-Total-Count` header. With no limit the whole (filtered) set is returned."""
    clauses, params = [], []
    if tournament_id is not None:
        clauses.append("e.tournament_id = %s"); params.append(tournament_id)
    if status is not None:
        clauses.append("e.status = %s"); params.append(status)
    if q:
        # USTA # search hits the matched player's number (p.usta_number) and the
        # number parsed from the email (e.detected_usta_text, persisted so it's
        # SQL-searchable even though the body is encrypted).
        clauses.append("(e.subject ILIKE %s OR e.from_address ILIKE %s "
                       "OR p.usta_number ILIKE %s OR e.detected_usta_text ILIKE %s)")
        params += [f"%{q}%", f"%{q}%", f"%{q}%", f"%{q}%"]
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        # Count uses the same FROM (joins to player) so a USTA-# `q` resolves.
        cur.execute(f"SELECT count(*) AS n {_FROM}{where}", params)
        response.headers["X-Total-Count"] = str(cur.fetchone()["n"])
        page, page_params = "", list(params)
        if limit is not None:
            page = " LIMIT %s OFFSET %s"; page_params += [limit, offset]
        cur.execute(f"SELECT {_COLS} {_FROM}{where} ORDER BY e.received_at DESC{page}", page_params)
        rows = cur.fetchall()
        # Post-process inside the cursor so we can lazily backfill the persisted
        # USTA # for pre-0039 rows (their column is NULL): compute from the
        # decrypted body once, store it, and it becomes searchable next time.
        for r in rows:
            r["body"] = _dec_body(r.get("body"))  # PII H2: encrypted at rest
            r["detected_reason"] = (
                extract_withdrawal_reason(r.get("subject"), r.get("body"))
                if r.get("classification") == "withdrawal" else None
            )
            # Structured fields the late-entry / withdrawal forms ask for — parsed
            # locally (no LLM) so single-file filing pre-fills them. Cheap regex;
            # null when nothing recognizable is present.
            r["detected_division"] = extract_age_division(r.get("subject"), r.get("body"))
            r["detected_events"] = extract_events(r.get("subject"), r.get("body"))
            # USTA # parsed from the email text — shown even when no roster player
            # is matched. Prefer the persisted column; backfill it if missing.
            if not r.get("detected_usta_text"):
                computed = extract_usta(r.get("subject"), r.get("body"))
                if computed:
                    cur.execute(
                        "UPDATE email_message SET detected_usta_text = %s WHERE id = %s",
                        (computed, r["id"]),
                    )
                r["detected_usta_text"] = computed
            # Day/time only make sense for scheduling-avoidance emails (a weekday in
            # a withdrawal email isn't an "avoid day"), so scope them to that class.
            is_sched = r.get("classification") == "scheduling_avoidance"
            r["detected_avoid_day"] = (
                extract_avoid_day(r.get("subject"), r.get("body")) if is_sched else None)
            r["detected_avoid_time"] = (
                extract_avoid_time(r.get("subject"), r.get("body")) if is_sched else None)
    return rows


@router.post("", response_model=EmailOut, status_code=201)
def create_email(body: EmailCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            # PII H2: encrypt the body at rest (decrypt-on-read everywhere else).
            # Persist the USTA # parsed from the plaintext so it stays searchable.
            params = {**body.model_dump(), "body": _enc_body(body.body),
                      "detected_usta_text": extract_usta(body.subject, body.body)}
            cur.execute(
                """
                INSERT INTO email_message (tournament_id, message_id, from_address, subject, body, detected_usta_text)
                VALUES (%(tournament_id)s, %(message_id)s, %(from_address)s, %(subject)s, %(body)s, %(detected_usta_text)s)
                RETURNING id
                """,
                params,
            )
            new_id = cur.fetchone()["id"]
            cur.execute(f"SELECT {_COLS} {_FROM} WHERE e.id = %s", (new_id,))
            row = cur.fetchone()
            row["body"] = _dec_body(row.get("body"))
            return row
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="an email with this message_id already exists")


@router.put("/{email_id}", response_model=EmailOut)
def update_email(email_id: int, body: EmailUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE email_message SET
                tournament_id = %(tournament_id)s, classification = %(classification)s,
                status = %(status)s,
                detected_match_kind = CASE
                    -- player cleared → no match kind
                    WHEN %(detected_player_id)s::int IS NULL THEN NULL
                    -- player changed to a new value → it was hand-picked
                    WHEN %(detected_player_id)s::int IS DISTINCT FROM detected_player_id THEN 'manual'
                    -- same player (e.g. a classification-only edit) → keep the
                    -- existing kind so an auto "usta" hit isn't relabelled
                    ELSE detected_match_kind END,
                detected_player_id = %(detected_player_id)s
            WHERE id = %(id)s RETURNING id
            """,
            {**body.model_dump(), "id": email_id},
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="email not found")
        cur.execute(f"SELECT {_COLS} {_FROM} WHERE e.id = %s", (email_id,))
        out = cur.fetchone()
        out["body"] = _dec_body(out.get("body"))
        return out


@router.post("/{email_id}/amends", response_model=EmailOut)
def set_amendment(email_id: int, body: EmailAmend, conn=Depends(db_dep)):
    """Mark this email as a correction of an earlier one (null clears the link).
    Both must be in the same tournament and an email can't amend itself. The
    earlier email is then reported as `superseded` so the TD revisits its row."""
    with conn.cursor() as cur:
        cur.execute("SELECT tournament_id FROM email_message WHERE id = %s", (email_id,))
        me = cur.fetchone()
        if me is None:
            raise HTTPException(status_code=404, detail="email not found")
        target = body.amends_email_id
        if target is not None:
            if target == email_id:
                raise HTTPException(status_code=400, detail="an email cannot amend itself")
            cur.execute("SELECT tournament_id FROM email_message WHERE id = %s", (target,))
            orig = cur.fetchone()
            if orig is None:
                raise HTTPException(status_code=404, detail="the amended email was not found")
            if orig["tournament_id"] != me["tournament_id"]:
                raise HTTPException(
                    status_code=400,
                    detail="the amended email is in a different tournament",
                )
        cur.execute(
            "UPDATE email_message SET amends_email_id = %s WHERE id = %s",
            (target, email_id),
        )
        cur.execute(f"SELECT {_COLS} {_FROM} WHERE e.id = %s", (email_id,))
        out = cur.fetchone()
        out["body"] = _dec_body(out.get("body"))
        return out


@router.post("/{email_id}/apply-correction")
def apply_correction(email_id: int, conn=Depends(db_dep)):
    """Apply a correction email to the filed row of the email it amends: re-point
    that row to this email and re-apply the locally-parsed fields, instead of
    creating a duplicate. Requires the email to be linked (`amends_email_id`) and
    a classification whose list supports it; 404 if the amended email has no filed
    row yet (file it normally first)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tournament_id, classification, detected_player_id, subject, "
            "body, amends_email_id FROM email_message WHERE id = %s",
            (email_id,),
        )
        em = cur.fetchone()
        if em is None:
            raise HTTPException(status_code=404, detail="email not found")
        em["body"] = _dec_body(em.get("body"))  # PII H2: decrypt for the extractors
        if em["amends_email_id"] is None:
            raise HTTPException(status_code=400,
                                detail="not a correction — link the email it amends first")
        target = POPULATE_TARGETS.get(em["classification"])
        if target is None or not target.get("amend_sql"):
            raise HTTPException(status_code=400,
                                detail=f"'{em['classification']}' rows can't be auto-corrected")
        extras = [_EXTRACTORS[name](em) for name in target.get("extract", [])]
        cur.execute(target["amend_sql"], (em["id"], *extras, em["amends_email_id"]))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(
                status_code=404,
                detail="the amended email has no filed row yet — file it normally first",
            )
        cur.execute("UPDATE email_message SET status = 'filed' WHERE id = %s", (em["id"],))
        return {"updated_row_id": row["id"], "list": em["classification"]}


@router.post("/{email_id}/suggest")
def suggest_classification(email_id: int, conn=Depends(db_dep)):
    """Local rule-based triage suggestion (no LLM, no data leaves the building)."""
    with conn.cursor() as cur:
        cur.execute("SELECT subject, body FROM email_message WHERE id = %s", (email_id,))
        row = cur.fetchone()
        if row is not None:
            row["body"] = _dec_body(row.get("body"))
    if row is None:
        raise HTTPException(status_code=404, detail="email not found")
    return {"classification": classify(row["subject"], row["body"])}


@router.delete("/{email_id}", status_code=204)
def delete_email(email_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM email_message WHERE id = %s", (email_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="email not found")
    return Response(status_code=204)


# ---------- Retention (PII hardening H3) -----------------------------------

@router.post("/purge")
def purge_filed_bodies(older_than_days: int = 30, conn=Depends(db_dep)):
    """Redact the free-text PII of FILED emails older than `older_than_days`:
    null body / subject / from_address while keeping the provenance row
    (message_id, classification, detected-player link, status) so the audit
    trail survives. Only `filed` emails are touched — unprocessed ('new') mail
    is never auto-purged. Returns how many were redacted.

    Inbound email is the highest-risk minors'-PII store (unstructured), so a
    retention sweep here is the §312.10 deletion step (docs/pii-hardening-plan
    §H3). Wire to a schedule for automatic enforcement."""
    if older_than_days < 0:
        raise HTTPException(status_code=400, detail="older_than_days must be >= 0")
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE email_message "
            "SET body = NULL, subject = NULL, from_address = NULL "
            "WHERE status = 'filed' "
            "  AND (body IS NOT NULL OR subject IS NOT NULL OR from_address IS NOT NULL) "
            "  AND received_at < now() - make_interval(days => %s) "
            "RETURNING id",
            (older_than_days,),
        )
        return {"purged": len(cur.fetchall())}


# ---------- Bulk inbox actions (mass-select on the inbox grid) -------------

@router.post("/bulk/reassign")
def bulk_reassign(body: EmailBulkReassign, conn=Depends(db_dep)):
    """Move every selected email to a different tournament's inbox."""
    if not body.email_ids:
        return {"updated": 0}
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tournament WHERE id = %s", (body.tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        cur.execute(
            "UPDATE email_message SET tournament_id = %s WHERE id = ANY(%s)",
            (body.tournament_id, body.email_ids),
        )
        return {"updated": cur.rowcount}


# Lightweight player-name detection used by both single-email "detect" and the
# bulk endpoint. Tries (1) USTA # in body, (2) full name match against the
# tournament roster, (3) last-name unique match. Returns the most confident
# hit + a `match_kind` for the UI to display.
_USTA_RE = re.compile(r"\b(\d{9,11})\b")
# A USTA # explicitly labeled in the text ("USTA #: 1234567890", "membership
# number 1234567890"). Higher confidence than a bare run of digits, so it wins.
_USTA_LABELED_RE = re.compile(
    r"(?:usta|membership)\s*(?:member(?:ship)?\s*)?(?:#|no\.?|number|id)?\s*[:#]?\s*(\d{8,11})",
    re.I,
)


def extract_usta(subject: str | None, body: str | None) -> str | None:
    """Pull the player's USTA # out of an email when present, independent of any
    roster match (so a PDF-imported email shows its USTA # even before — or
    without — a player is matched). Prefers an explicitly *labeled* number; falls
    back to a lone bare 9–11 digit run, and gives up if several bare numbers
    appear (ambiguous — could be a phone, a confirmation #, etc.)."""
    text = f"{subject or ''}\n{body or ''}"
    m = _USTA_LABELED_RE.search(text)
    if m:
        return m.group(1)
    nums = set(_USTA_RE.findall(text))
    return next(iter(nums)) if len(nums) == 1 else None
# USTA portal withdrawal body line: "<Full Name> has requested to be withdrawn"
_WITHDRAW_BODY_RE = re.compile(
    r"([A-Z][\w'.\-]+(?:\s+[A-Z][\w'.\-]+)+)\s+has\s+requested\s+to\s+be\s+withdrawn", re.I)
# USTA portal withdrawal subject: "WITHDRAWAL REQUEST: <First>, Boys'/Girls' <N> & under …"
_USTA_SUBJECT_RE = re.compile(
    r"withdrawal\s+request\s*[:\-]\s*([A-Za-z][\w'\-]+)\s*,\s*(boys|girls)\b[^\d]*?(\d+)", re.I)


def _detect_player_for(cur, tournament_id: int, subject: str, body: str,
                       from_address: str = "") -> dict:
    """Best-effort "which player is this email about" detector.

    Layered from most to least reliable; the FIRST layer that yields an
    unambiguous roster hit wins, so high-precision signals (an explicit USTA #,
    a full name in the subject, the USTA portal withdrawal template) always beat
    weaker ones (a bare surname). Each layer is deliberately conservative — when
    a signal is ambiguous (e.g. two roster players share a surname) it is
    skipped rather than guessed, so a wrong tag is rarer than no tag.

    `match_kind` is returned for the UI so the TD can see *why* a player was
    picked (and trust a "usta" hit more than a "lastname" guess).
    """
    subject = subject or ""
    body = body or ""
    from_address = from_address or ""
    subj_low = subject.lower()
    text = f"{subject}\n{body}\n{from_address}"
    text_low = text.lower()

    cur.execute(
        "SELECT p.id, p.usta_number, p.first_name, p.last_name, p.gender, "
        "       e.age_division, "
        "       TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) AS name "
        "FROM player p JOIN tournament_entry e ON e.player_id = p.id "
        "WHERE e.tournament_id = %s",
        (tournament_id,),
    )
    roster = cur.fetchall()

    def ret(r, kind):
        return {"detected_player_id": r["id"], "detected_usta": r["usta_number"],
                "detected_player_name": r["name"], "match_kind": kind}

    def fullname_in(hay_low, r):
        f = (r["first_name"] or "").strip().lower()
        l = (r["last_name"] or "").strip().lower()
        if not f or not l:
            return False
        return f"{f} {l}" in hay_low or f"{l}, {f}" in hay_low

    # L1 — explicit USTA # anywhere in the email matched to a roster player.
    ustas = set(_USTA_RE.findall(text))
    if ustas:
        for r in roster:
            if r["usta_number"] and r["usta_number"] in ustas:
                return ret(r, "usta")

    # L2 — full name in the SUBJECT (subjects are deliberate → high precision).
    for r in roster:
        if fullname_in(subj_low, r):
            return ret(r, "fullname_subject")

    # L3 — USTA portal body template "<Full Name> has requested to be withdrawn".
    m = _WITHDRAW_BODY_RE.search(body)
    if m:
        cand = " ".join(m.group(1).split()).lower()
        for r in roster:
            if r["name"].lower() == cand:
                return ret(r, "withdraw_template")

    # L4 — full name anywhere in the body.
    for r in roster:
        if fullname_in(text_low, r):
            return ret(r, "fullname_body")

    # L5 — USTA portal subject template (first name + gender + age division).
    # Catches "WITHDRAWAL REQUEST: Siddhanth, Boys' 14 & under singles" where the
    # body lacks the surname: match first name within the right gender+division,
    # and only commit if exactly one roster player fits.
    sm = _USTA_SUBJECT_RE.search(subject)
    if sm:
        fn, gender_word, age = sm.group(1).lower(), sm.group(2).lower(), sm.group(3)
        want_gender = "male" if gender_word == "boys" else "female"
        cands = [r for r in roster
                 if (r["first_name"] or "").strip().lower() == fn
                 and (r["gender"] or "").lower() == want_gender
                 and age in (r["age_division"] or "")]
        if len(cands) == 1:
            return ret(cands[0], "usta_subject")

    # L6 — unique surname in the SUBJECT.
    subj_last = [r for r in roster if r["last_name"]
                 and re.search(rf"\b{re.escape(r['last_name'])}\b", subject, re.IGNORECASE)]
    if len(subj_last) == 1:
        return ret(subj_last[0], "lastname_subject")

    # L7 — unique surname anywhere (subject + body + sender). Last resort; only
    # fires when exactly one roster surname appears, so club/parent senders that
    # share a player's surname resolve to that lone player.
    text_last = [r for r in roster if r["last_name"]
                 and re.search(rf"\b{re.escape(r['last_name'])}\b", text, re.IGNORECASE)]
    if len(text_last) == 1:
        return ret(text_last[0], "lastname")

    return {"detected_player_id": None, "detected_usta": None,
            "detected_player_name": None, "match_kind": None}


# Withdrawal-reason extraction, ranked most→least reliable based on the real
# email corpus:
#   1. explicit "Reason: <X>" field (forwarded forms: "Player Name… Reason: Injury
#      Round/Event:…") — but NOT the USTA portal's "for the following reason:"
#      boilerplate, which is followed by canned "Please go to…" text (no reason).
#   2. "due to <X>" free text ("…due to leg injury.").
#   3. keyword fallback → a normalized category (Injury / Illness).
# Returns a short string or None (None ⇒ TD fills it in by hand).
_REASON_FIELD_RE = re.compile(r"(?<!following )reason\s*[:\-]\s*(.+)", re.I)
_REASON_STOP_RE = re.compile(r"\b(?:round/event|event|round|player name|withdrawing)\s*[:\-]?", re.I)
_DUE_TO_RE = re.compile(r"\bdue to\s+(.+?)(?:[.;\n]|\bplease\b|\bthanks?\b|$)", re.I)


def extract_withdrawal_reason(subject: str, body: str):
    text = f"{subject or ''}\n{body or ''}"
    # 1) explicit "Reason: X" on a line (skip the portal boilerplate).
    for line in text.splitlines():
        m = _REASON_FIELD_RE.search(line)
        if not m:
            continue
        val = _REASON_STOP_RE.split(m.group(1).strip(), maxsplit=1)[0].strip(" .,;-")
        if val and not val.lower().startswith(("please", "the player")):
            return val[:80]
    # 2) "due to <reason>"
    m = _DUE_TO_RE.search(text)
    if m:
        val = m.group(1).strip(" .,;-")
        if val:
            return val[:80]
    # 3) keyword fallback → normalized category
    low = text.lower()
    if re.search(r"\b(injur(?:y|ed|ies)|hurt|broke|broken|sprain(?:ed)?|fracture)\b", low):
        return "Injury"
    if re.search(r"\b(sick|illness|ill|unwell|fever|covid|flu)\b", low):
        return "Illness"
    return None


# Junior age-division extraction → a canonical roster code (B/G + age), so the
# inbox can pre-fill the late-entry "Age division" picker. Two signals:
#   1. an explicit code already in the text ("B14", "G 16")
#   2. the USTA wording "Boys'/Girls' <age> [& under]"
# Only the junior ladder (10/12/14/16/18) is recognized — adult NTRP/Combo
# divisions aren't named in these parent emails, so we don't guess them.
_JUNIOR_AGES = {"10", "12", "14", "16", "18"}
_DIV_WORD_RE = re.compile(r"\b(boys|girls)['‘’ʼ]?\s*(10|12|14|16|18)\b", re.I)
_DIV_CODE_RE = re.compile(r"\b([BG])\s?-?\s?(10|12|14|16|18)\b")


def extract_age_division(subject: str, body: str):
    """Best-effort junior division code (e.g. 'B14') from the email, or None."""
    text = f"{subject or ''}\n{body or ''}"
    m = _DIV_WORD_RE.search(text)
    if m:
        return ("B" if m.group(1).lower() == "boys" else "G") + m.group(2)
    m = _DIV_CODE_RE.search(text)
    if m and m.group(2) in _JUNIOR_AGES:
        return m.group(1).upper() + m.group(2)
    return None


def extract_events(subject: str, body: str):
    """Comma-joined junior event names mentioned ('Singles, Doubles'), or None.
    Values match the event-catalog option values the late/withdrawal forms use,
    so the inbox can pre-select them. 'mixed [doubles]' → 'Mixed Doubles', and
    that phrase is stripped before the plain-doubles check so it isn't counted
    twice."""
    t = f"{subject or ''} {body or ''}".lower()
    out = []
    if re.search(r"\bsingles\b", t):
        out.append("Singles")
    if re.search(r"\bmixed\b", t):
        out.append("Mixed Doubles")
    if re.search(r"\bdoubles\b", re.sub(r"\bmixed\s+doubles\b", "", t)):
        out.append("Doubles")
    return ", ".join(out) or None


# Scheduling-avoidance day + time-range extraction → the two free-text fields the
# scheduling form asks for. Conservative: surface what's clearly stated, leave the
# rest for the TD.
_DAYS = [("monday", "Mon"), ("tuesday", "Tue"), ("wednesday", "Wed"),
         ("thursday", "Thu"), ("friday", "Fri"), ("saturday", "Sat"), ("sunday", "Sun")]
_TIME_RE = re.compile(
    r"\b(before|after|by|until|till)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?",
    re.I)
_DAYPART_RE = re.compile(r"\b(mornings?|afternoons?|evenings?|nights?|noon|midday)\b", re.I)


def extract_avoid_day(subject: str, body: str):
    """Weekday(s) mentioned, as abbreviations ('Sat' / 'Sat, Sun'), or None."""
    t = f"{subject or ''} {body or ''}".lower()
    found = [abbr for full, abbr in _DAYS
             if re.search(rf"\b({full}|{abbr.lower()})\b", t)]
    return ", ".join(found) or None


def extract_avoid_time(subject: str, body: str):
    """A short time-constraint string ('before 10 am', 'after 5 pm', 'mornings')
    or None. A before/after/until clause wins over a vaguer day-part word."""
    text = f"{subject or ''} {body or ''}"
    m = _TIME_RE.search(text)
    if m:
        prep, hour = m.group(1).lower(), m.group(2)
        mins = f":{m.group(3)}" if m.group(3) else ""
        mer = (m.group(4) or "").lower().replace(".", "")
        return f"{prep} {hour}{mins}{(' ' + mer) if mer else ''}"[:40]
    m = _DAYPART_RE.search(text)
    if m:
        return m.group(1).lower()
    return None


# Maps the `extract` field names declared on POPULATE_TARGETS (email_targets.py)
# to the function that derives that value from an email row. bulk_populate uses
# this so its extra INSERT params match each target's bulk_sql column order. The
# registry-consistency test asserts every declared name has an entry here.
_EXTRACTORS = {
    "reason": lambda em: extract_withdrawal_reason(em["subject"], em["body"]),
    "division": lambda em: extract_age_division(em["subject"], em["body"]),
    "events": lambda em: extract_events(em["subject"], em["body"]),
    "avoid_day": lambda em: extract_avoid_day(em["subject"], em["body"]),
    "avoid_time": lambda em: extract_avoid_time(em["subject"], em["body"]),
}


@router.post("/{email_id}/detect-player", response_model=EmailDetectResult)
def detect_one_player(email_id: int, conn=Depends(db_dep)):
    """Run the player-name detector against this email's subject+body and
    persist the result (overwrites any previous detected_player_id)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tournament_id, subject, body, from_address FROM email_message WHERE id = %s",
            (email_id,),
        )
        em = cur.fetchone()
        if em is None:
            raise HTTPException(status_code=404, detail="email not found")
        if em["tournament_id"] is None:
            raise HTTPException(status_code=400, detail="email has no tournament; assign one first")
        d = _detect_player_for(cur, em["tournament_id"], em["subject"],
                               _dec_body(em["body"]), em["from_address"])
        cur.execute(
            "UPDATE email_message SET detected_player_id = %s, detected_match_kind = %s WHERE id = %s",
            (d["detected_player_id"], d["match_kind"], email_id),
        )
        return {"email_id": email_id, **d}


@router.post("/bulk/detect-players", response_model=list[EmailDetectResult])
def bulk_detect_players(body: EmailBulkDetect, conn=Depends(db_dep)):
    out: list[dict] = []
    if not body.email_ids:
        return out
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tournament_id, subject, body, from_address FROM email_message WHERE id = ANY(%s)",
            (body.email_ids,),
        )
        for em in cur.fetchall():
            if em["tournament_id"] is None:
                out.append({"email_id": em["id"], "detected_player_id": None,
                            "detected_usta": None, "detected_player_name": None,
                            "match_kind": None})
                continue
            d = _detect_player_for(cur, em["tournament_id"], em["subject"],
                                   _dec_body(em["body"]), em["from_address"])
            cur.execute(
                "UPDATE email_message SET detected_player_id = %s, detected_match_kind = %s WHERE id = %s",
                (d["detected_player_id"], d["match_kind"], em["id"]),
            )
            out.append({"email_id": em["id"], **d})
    return out


@router.get("/targets")
def list_targets():
    """The canonical classification→list registry the frontend builds its
    "File as …" menu + labels from (single source of truth — see
    ``app/email_targets.py``)."""
    return public_targets()


# The bulk-populate INSERT map (classification → {sql, label}) is derived from
# the shared registry in app/email_targets.py — NOT redefined here — so its keys
# can never drift from triage's outputs / the frontend's FILE_TARGETS again
# (the "scheduling" vs "scheduling_avoidance" silent-skip bug). doubles +
# pairing_avoidance are deliberately absent (SINGLE_FILE_ONLY_KEYS): their rows
# need fields a single email + detected player can't supply, so the TD files
# them through the form; the bulk action reports them with a clear reason.


@router.post("/bulk/populate")
def bulk_populate(body: EmailBulkPopulate, conn=Depends(db_dep)):
    """For each selected email, INSERT a row in the per-classification target
    table (withdrawal / late_entry / etc.) using the email's detected player
    + tournament. Marks each successfully-filed email status='filed'.

    Returns counts + a list of skipped emails (with reasons) so the inbox
    grid can flag the rows that still need manual review."""
    if not body.email_ids:
        return {"filed": 0, "skipped": []}
    skipped: list[dict] = []
    filed_count = 0
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tournament_id, classification, detected_player_id, subject, body "
            "FROM email_message WHERE id = ANY(%s)",
            (body.email_ids,),
        )
        rows = cur.fetchall()
        for em in rows:
            em["body"] = _dec_body(em.get("body"))  # PII H2: for the extractors
            tid, cls, pid = em["tournament_id"], em["classification"], em["detected_player_id"]
            target = POPULATE_TARGETS.get(cls)
            if target is None:
                # Distinguish "fileable but only one-at-a-time" (doubles/pairing)
                # from a genuinely unhandled classification, so the TD knows to
                # file it from the form rather than thinking it failed.
                reason = (f"'{cls}' must be filed individually from its form"
                          if cls in SINGLE_FILE_ONLY_KEYS
                          else f"no target for '{cls}'")
                skipped.append({"id": em["id"], "reason": reason})
                continue
            if pid is None:
                skipped.append({"id": em["id"], "reason": "no detected player"})
                continue
            if tid is None:
                skipped.append({"id": em["id"], "reason": "no tournament"})
                continue
            try:
                # Append each target's locally-parsed extras (reason / division /
                # events) after the core params, in the registry's declared order,
                # so bulk fills the same fields single-file does (no LLM).
                extras = [_EXTRACTORS[name](em) for name in target.get("extract", [])]
                cur.execute(target["sql"], (tid, pid, em["id"], *extras))
                if cur.rowcount > 0:
                    filed_count += 1
                    cur.execute("UPDATE email_message SET status='filed' WHERE id=%s", (em["id"],))
                else:
                    skipped.append({"id": em["id"], "reason": f"{target['label']} already exists"})
            except psycopg.Error as e:
                skipped.append({"id": em["id"], "reason": str(e).splitlines()[0][:120]})
    return {"filed": filed_count, "skipped": skipped}
