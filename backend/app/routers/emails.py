"""Part B review inbox: inbound parent/player email, filed by a human (D5/§5.1)."""
import re

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
from ..models import (
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
    "e.detected_match_kind, "
    "p.usta_number AS detected_usta, "
    "TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) "
    "  AS detected_player_name, "
    "tn.name AS tournament_name"
)
_FROM = ("FROM email_message e "
         "LEFT JOIN player p ON p.id = e.detected_player_id "
         "LEFT JOIN tournament tn ON tn.id = e.tournament_id")


@router.get("", response_model=list[EmailOut])
def list_emails(tournament_id: int | None = None, status: str | None = None, conn=Depends(db_dep)):
    clauses, params = [], []
    if tournament_id is not None:
        clauses.append("e.tournament_id = %s"); params.append(tournament_id)
    if status is not None:
        clauses.append("e.status = %s"); params.append(status)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLS} {_FROM}{where} ORDER BY e.received_at DESC", params)
        return cur.fetchall()


@router.post("", response_model=EmailOut, status_code=201)
def create_email(body: EmailCreate, conn=Depends(db_dep)):
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO email_message (tournament_id, message_id, from_address, subject, body)
                VALUES (%(tournament_id)s, %(message_id)s, %(from_address)s, %(subject)s, %(body)s)
                RETURNING id
                """,
                body.model_dump(),
            )
            new_id = cur.fetchone()["id"]
            cur.execute(f"SELECT {_COLS} {_FROM} WHERE e.id = %s", (new_id,))
            return cur.fetchone()
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
        return cur.fetchone()


@router.post("/{email_id}/suggest")
def suggest_classification(email_id: int, conn=Depends(db_dep)):
    """Local rule-based triage suggestion (no LLM, no data leaves the building)."""
    with conn.cursor() as cur:
        cur.execute("SELECT subject, body FROM email_message WHERE id = %s", (email_id,))
        row = cur.fetchone()
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
        d = _detect_player_for(cur, em["tournament_id"], em["subject"], em["body"], em["from_address"])
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
            d = _detect_player_for(cur, em["tournament_id"], em["subject"], em["body"], em["from_address"])
            cur.execute(
                "UPDATE email_message SET detected_player_id = %s, detected_match_kind = %s WHERE id = %s",
                (d["detected_player_id"], d["match_kind"], em["id"]),
            )
            out.append({"email_id": em["id"], **d})
    return out


# Map classification → (target_table, insert_template). Each template uses
# named params: tid, pid, sid. Same idea as the FILE_TARGETS map on the
# frontend, but server-side so the bulk "populate" action can run without
# the user clicking through each form. Players without a detected_player_id
# are skipped (the response reports them).
_POPULATE_TARGETS = {
    "withdrawal": {
        "sql": ("INSERT INTO withdrawal (tournament_id, player_id, source_email_id) "
                "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING RETURNING id"),
        "label": "withdrawal",
    },
    "late_entry": {
        "sql": ("INSERT INTO late_entry (tournament_id, player_id, source_email_id) "
                "VALUES (%s, %s, %s) RETURNING id"),
        "label": "late entry",
    },
    "scheduling": {
        "sql": ("INSERT INTO scheduling_avoidance (tournament_id, player_id, source_email_id) "
                "VALUES (%s, %s, %s) RETURNING id"),
        "label": "scheduling avoidance",
    },
    "division_flex": {
        "sql": ("INSERT INTO division_flexibility (tournament_id, player_id, source_email_id) "
                "VALUES (%s, %s, %s) RETURNING id"),
        "label": "division flexibility",
    },
    "hotel": {
        "sql": ("INSERT INTO player_hotel_stay (tournament_id, player_id, source_email_id) "
                "VALUES (%s, %s, %s) RETURNING id"),
        "label": "player hotel",
    },
    # doubles_request requires a `wants_random` or `partner_usta` — without
    # one of those the row violates the CHECK, so we skip and report it. The
    # TD opens the email's detail pane + clicks File → instead.
}


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
            "SELECT id, tournament_id, classification, detected_player_id "
            "FROM email_message WHERE id = ANY(%s)",
            (body.email_ids,),
        )
        rows = cur.fetchall()
        for em in rows:
            tid, cls, pid = em["tournament_id"], em["classification"], em["detected_player_id"]
            target = _POPULATE_TARGETS.get(cls)
            if target is None:
                skipped.append({"id": em["id"], "reason": f"no target for '{cls}'"})
                continue
            if pid is None:
                skipped.append({"id": em["id"], "reason": "no detected player"})
                continue
            if tid is None:
                skipped.append({"id": em["id"], "reason": "no tournament"})
                continue
            try:
                cur.execute(target["sql"], (tid, pid, em["id"]))
                if cur.rowcount > 0:
                    filed_count += 1
                    cur.execute("UPDATE email_message SET status='filed' WHERE id=%s", (em["id"],))
                else:
                    skipped.append({"id": em["id"], "reason": f"{target['label']} already exists"})
            except psycopg.Error as e:
                skipped.append({"id": em["id"], "reason": str(e).splitlines()[0][:120]})
    return {"filed": filed_count, "skipped": skipped}
