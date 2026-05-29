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
    "p.usta_number AS detected_usta, "
    "TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) "
    "  AS detected_player_name"
)
_FROM = "FROM email_message e LEFT JOIN player p ON p.id = e.detected_player_id"


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
_NAME_TOKEN_RE = re.compile(r"[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?")  # capitalized words


def _detect_player_for(cur, tournament_id: int, subject: str, body: str) -> dict:
    text = f"{subject or ''}\n{body or ''}"
    # 1) Match a USTA # in the body against the tournament's roster.
    for m in _USTA_RE.finditer(text):
        usta = m.group(1)
        cur.execute(
            "SELECT p.id, p.usta_number, "
            "       TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) AS name "
            "FROM player p JOIN tournament_entry e ON e.player_id = p.id "
            "WHERE e.tournament_id = %s AND p.usta_number = %s LIMIT 1",
            (tournament_id, usta),
        )
        hit = cur.fetchone()
        if hit:
            return {"detected_player_id": hit["id"], "detected_usta": hit["usta_number"],
                    "detected_player_name": hit["name"], "match_kind": "usta"}
    # 2) Full-name match. Iterate roster + look for "<First> <Last>" in text.
    cur.execute(
        "SELECT p.id, p.usta_number, p.first_name, p.last_name, "
        "       TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) AS name "
        "FROM player p JOIN tournament_entry e ON e.player_id = p.id "
        "WHERE e.tournament_id = %s",
        (tournament_id,),
    )
    roster = cur.fetchall()
    text_low = text.lower()
    # 2a) FullName "First Last" or "Last, First" anywhere in the text.
    for r in roster:
        f, l = (r["first_name"] or "").strip().lower(), (r["last_name"] or "").strip().lower()
        if not f or not l:
            continue
        if f"{f} {l}" in text_low or f"{l}, {f}" in text_low:
            return {"detected_player_id": r["id"], "detected_usta": r["usta_number"],
                    "detected_player_name": r["name"], "match_kind": "fullname"}
    # 3) Last-name unique match. Avoids false positives by requiring exactly one
    # roster row whose last name appears in the text.
    last_hits = [r for r in roster
                 if r["last_name"] and re.search(rf"\b{re.escape(r['last_name'])}\b", text, re.IGNORECASE)]
    if len(last_hits) == 1:
        r = last_hits[0]
        return {"detected_player_id": r["id"], "detected_usta": r["usta_number"],
                "detected_player_name": r["name"], "match_kind": "lastname"}
    return {"detected_player_id": None, "detected_usta": None,
            "detected_player_name": None, "match_kind": None}


@router.post("/{email_id}/detect-player", response_model=EmailDetectResult)
def detect_one_player(email_id: int, conn=Depends(db_dep)):
    """Run the player-name detector against this email's subject+body and
    persist the result (overwrites any previous detected_player_id)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tournament_id, subject, body FROM email_message WHERE id = %s",
            (email_id,),
        )
        em = cur.fetchone()
        if em is None:
            raise HTTPException(status_code=404, detail="email not found")
        if em["tournament_id"] is None:
            raise HTTPException(status_code=400, detail="email has no tournament; assign one first")
        d = _detect_player_for(cur, em["tournament_id"], em["subject"], em["body"])
        cur.execute(
            "UPDATE email_message SET detected_player_id = %s WHERE id = %s",
            (d["detected_player_id"], email_id),
        )
        return {"email_id": email_id, **d}


@router.post("/bulk/detect-players", response_model=list[EmailDetectResult])
def bulk_detect_players(body: EmailBulkDetect, conn=Depends(db_dep)):
    out: list[dict] = []
    if not body.email_ids:
        return out
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tournament_id, subject, body FROM email_message WHERE id = ANY(%s)",
            (body.email_ids,),
        )
        for em in cur.fetchall():
            if em["tournament_id"] is None:
                out.append({"email_id": em["id"], "detected_player_id": None,
                            "detected_usta": None, "detected_player_name": None,
                            "match_kind": None})
                continue
            d = _detect_player_for(cur, em["tournament_id"], em["subject"], em["body"])
            cur.execute(
                "UPDATE email_message SET detected_player_id = %s WHERE id = %s",
                (d["detected_player_id"], em["id"]),
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
