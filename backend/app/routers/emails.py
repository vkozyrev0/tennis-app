"""Part B review inbox: inbound parent/player email, filed by a human (D5/§5.1)."""
import re
import unicodedata

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..crypto import decrypt as _dec_body
from ..crypto import encrypt as _enc_body
from ..db import db_dep
# Pure text extractors live in app/email_extract.py (plan P2 #9); imported
# here both for use and for back-compat re-export (importer.py + tests
# import them from this module).
from ..email_extract import (
    extract_name_usta_pairs,
    extract_names,    # name-only spans (the doubles partner fallback signal)
    extract_doubles_pair,  # two names joined by a pairing connector (no USTA #)
    extract_surname_pair,  # slashed surname shorthand in a subject (Pfifer / Mehendiratta)
    extract_withdraw_name,  # the withdrawing player's name (surface when unmatched)
    usta_candidates,  # the roster detector's L1 candidate list (ordered)
    extract_age_division,
    extract_avoid_day,
    extract_avoid_time,
    extract_events,
    extract_usta,
    extract_ustas,
    extract_withdrawal_reason,
)
from ..email_targets import (
    POPULATE_TARGETS,
    SINGLE_FILE_ONLY_KEYS,
    public_targets,
)
from ..models import (
    EmailAmend,
    EmailBulkClassify,
    EmailBulkDetect,
    EmailBulkPopulate,
    EmailBulkReassign,
    EmailBulkStatus,
    EmailCreate,
    EmailDetectResult,
    EmailOut,
    EmailUpdate,
)
from ..bulk_ops import savepoint
from ..playerops import mark_email_filed
from ..query_helpers import like_escape, paged_select
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
    "e.detected_partner_id, pp.usta_number AS detected_partner_usta, "
    "e.detected_member_ids, "
    "(SELECT array_agg(TRIM(COALESCE(m.first_name,'') || ' ' || COALESCE(m.last_name,'')) "
    "                  ORDER BY array_position(e.detected_member_ids, m.id)) "
    " FROM player m WHERE m.id = ANY(e.detected_member_ids)) AS detected_member_names, "
    "NULLIF(TRIM(COALESCE(pp.first_name,'') || ' ' || COALESCE(pp.last_name,'')), '') "
    "  AS detected_partner_name, "
    "tn.name AS tournament_name, "
    # Amendment lineage: what this email corrects (am.subject) and whether a
    # later email corrects THIS one (superseded → the filed row may be stale).
    "e.amends_email_id, am.subject AS amends_subject, "
    "EXISTS (SELECT 1 FROM email_message s WHERE s.amends_email_id = e.id) AS superseded"
)
_FROM = ("FROM email_message e "
         "LEFT JOIN player p ON p.id = e.detected_player_id "
         "LEFT JOIN player pp ON pp.id = e.detected_partner_id "
         "LEFT JOIN tournament tn ON tn.id = e.tournament_id "
         "LEFT JOIN email_message am ON am.id = e.amends_email_id")


@router.get("", response_model=list[EmailOut])
def list_emails(response: Response, tournament_id: int | None = None,
                status: str | None = None, q: str | None = None,
                unmatched: bool | None = None,
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
    if unmatched:
        # Detection gap: no roster player matched. Feeds the unmatched drilldown.
        clauses.append("e.detected_player_id IS NULL")
    if q:
        # USTA # search hits the matched player's number (p.usta_number) and the
        # number parsed from the email (e.detected_usta_text, persisted so it's
        # SQL-searchable even though the body is encrypted).
        clauses.append("(e.subject ILIKE %s OR e.from_address ILIKE %s "
                       "OR p.usta_number ILIKE %s OR e.detected_usta_text ILIKE %s)")
        eq = like_escape(q)
        params += [f"%{eq}%", f"%{eq}%", f"%{eq}%", f"%{eq}%"]
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        # Count uses the same FROM (joins to player) so a USTA-# `q` resolves.
        rows = paged_select(cur, response, cols=_COLS, from_sql=_FROM,
                            where=where, params=params,
                            order_by=" ORDER BY e.received_at DESC",
                            limit=limit, offset=offset)
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
            # USTA #(s) parsed from the email text — shown even when no roster
            # player is matched. Prefer the persisted column; backfill if
            # missing. Multi-player classes may carry a number for one player,
            # both, or neither — keep every plausible one (comma-joined).
            if not r.get("detected_usta_text"):
                if r.get("classification") in ("doubles", "pairing_avoidance"):
                    computed = ", ".join(extract_ustas(r.get("subject"), r.get("body"))) or None
                else:
                    computed = extract_usta(r.get("subject"), r.get("body"))
                if computed:
                    cur.execute(
                        "UPDATE email_message SET detected_usta_text = %s WHERE id = %s",
                        (computed, r["id"]),
                    )
                r["detected_usta_text"] = computed
            # (name, USTA#) pairs parsed from the text — for doubles/pairing
            # emails whose players aren't (yet) rostered, the email itself says
            # who the players are; the grid falls back to these. When the email
            # carries NO USTA # (the common doubles shape — "Mia Langone and
            # Chelsea Ie would like to pair up"), surface the two NAMES anyway so
            # both players still show for the TD to confirm / add to the roster.
            if r.get("classification") in ("doubles", "pairing_avoidance"):
                pairs = extract_name_usta_pairs(r.get("subject"), r.get("body"))
                if len(pairs) < 2:
                    have = {_norm_name(p["name"]) for p in pairs}
                    names = (extract_doubles_pair(r.get("subject"), r.get("body"))
                             if r.get("classification") == "doubles"
                             else extract_names(r.get("subject"), r.get("body")))
                    # Slashed surname shorthand in the subject ("… - Pfifer /
                    # Mehendiratta") — the same pair the classifier counts, so a
                    # doubles label never shows blank Player columns.
                    if r.get("classification") == "doubles":
                        names = [*names, *extract_surname_pair(r.get("subject"))]
                    for nm in names:
                        if _norm_name(nm) not in have:
                            pairs.append({"name": nm, "usta": None})
                            have.add(_norm_name(nm))
                r["detected_name_pairs"] = pairs[:4] or None
            elif r.get("classification") == "withdrawal" and not r.get("detected_player_id"):
                # Withdrawal naming a player who isn't matched to the roster:
                # surface the parsed name (same grid path as doubles) so the TD
                # sees who instead of a blank, with the ＋ add affordance.
                nm = extract_withdraw_name(r.get("subject"), r.get("body"))
                r["detected_name_pairs"] = [{"name": nm, "usta": None}] if nm else None
            else:
                r["detected_name_pairs"] = None
            # Day/time only make sense for scheduling-avoidance emails (a weekday in
            # a withdrawal email isn't an "avoid day"), so scope them to that class.
            is_sched = r.get("classification") == "scheduling_avoidance"
            r["detected_avoid_day"] = (
                extract_avoid_day(r.get("subject"), r.get("body")) if is_sched else None)
            r["detected_avoid_time"] = (
                extract_avoid_time(r.get("subject"), r.get("body")) if is_sched else None)
    return rows


@router.get("/status-counts")
def status_counts(tournament_id: int | None = None, conn=Depends(db_dep)):
    """Inbox progress at a glance: how many emails are still **new** (unfiled) vs
    **filed** vs **need follow-up**, so the TD sees what's left to process. The
    `new` count is the actionable one."""
    clauses, params = [], []
    if tournament_id is not None:
        clauses.append("tournament_id = %s"); params.append(tournament_id)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT status, count(*) AS n FROM email_message{where} GROUP BY status",
            params,
        )
        by = {r["status"]: r["n"] for r in cur.fetchall()}
        # Detection gaps: still-unfiled emails on a tournament that no roster
        # player matched — the actionable drilldown the TD resolves before triage.
        gap_clauses = clauses + ["status = 'new'", "detected_player_id IS NULL",
                                 "tournament_id IS NOT NULL"]
        gap_where = " WHERE " + " AND ".join(gap_clauses)
        cur.execute(f"SELECT count(*) AS n FROM email_message{gap_where}", params)
        unmatched = cur.fetchone()["n"]
    new = by.get("new", 0)
    filed = by.get("filed", 0)
    follow = by.get("needs_followup", 0)
    return {"new": new, "filed": filed, "needs_followup": follow,
            "unmatched": unmatched, "total": new + filed + follow}


@router.get("/aging")
def inbox_aging(tournament_id: int | None = None, limit: int = 10, conn=Depends(db_dep)):
    """Oldest UNFILED emails first, with how many days each has been waiting — an
    SLA-style triage list so nothing languishes. Optionally scoped to one
    tournament. Subject/sender only (the body stays encrypted); the inbox opens
    the full email. `oldest_age_days` is the headline number."""
    limit = max(1, min(limit, 100))
    clauses = ["e.status = 'new'"]
    params: list = []
    if tournament_id is not None:
        clauses.append("e.tournament_id = %s"); params.append(tournament_id)
    where = " WHERE " + " AND ".join(clauses)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT e.id, e.tournament_id, e.subject, e.from_address, e.classification, "
            "       e.received_at, "
            "       GREATEST(0, EXTRACT(DAY FROM (now() - e.received_at)))::int AS age_days "
            f"FROM email_message e{where} "
            "ORDER BY e.received_at ASC NULLS FIRST "
            "LIMIT %s",
            params + [limit],
        )
        rows = cur.fetchall()
    items = [{
        "id": r["id"], "tournament_id": r["tournament_id"],
        "subject": r["subject"], "from_address": r["from_address"],
        "classification": r["classification"],
        "received_at": r["received_at"].isoformat() if r["received_at"] else None,
        "age_days": r["age_days"],
    } for r in rows]
    return {"items": items, "count": len(items),
            "oldest_age_days": items[0]["age_days"] if items else 0}


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
                detected_player_id = %(detected_player_id)s,
                -- partner only makes sense on doubles emails; a re-classification
                -- away from doubles (or clearing the player) drops it
                -- manual partner assignment wins (the TD typed/picked it);
                -- clearing the player clears the partner too. Auto-detection
                -- still only FILLS this for doubles emails.
                detected_partner_id = CASE
                    WHEN %(detected_player_id)s::int IS NULL THEN NULL
                    ELSE %(detected_partner_id)s::int END,
                detected_member_ids = CASE
                    WHEN %(classification)s <> 'pairing_avoidance' THEN NULL
                    WHEN %(detected_player_id)s::int IS NULL THEN NULL
                    ELSE detected_member_ids END
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
        # Through the shared helper (not an inline UPDATE) so the "filed" rule
        # can't drift between single-file, amend, and bulk paths (plan P1 #6).
        mark_email_filed(cur, em["id"], em["classification"])
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


@router.post("/bulk/status")
def bulk_status(body: EmailBulkStatus, conn=Depends(db_dep)):
    """Mark every selected email filed / needs-follow-up / new. Lets the TD clear
    the info-only emails (hotel notes, acknowledgements) that don't populate a
    request list but should still leave the 'unfiled' queue."""
    if not body.email_ids:
        return {"updated": 0}
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE email_message SET status = %s WHERE id = ANY(%s)",
            (body.status, body.email_ids),
        )
        return {"updated": cur.rowcount}


# Lightweight player-name detection used by both single-email "detect" and the
# bulk endpoint. Tries (1) USTA # in body, (2) full name match against the
# tournament roster, (3) last-name unique match. Returns the most confident
# hit + a `match_kind` for the UI to display.
# USTA portal withdrawal body line: "<Full Name> has requested to be withdrawn"
_WITHDRAW_BODY_RE = re.compile(
    r"([A-Z][\w'.\-]+(?:\s+[A-Z][\w'.\-]+)+)\s+has\s+requested\s+to\s+be\s+withdrawn", re.I)
# USTA portal withdrawal subject: "WITHDRAWAL REQUEST: <First>, Boys'/Girls' <N> & under …"
_USTA_SUBJECT_RE = re.compile(
    r"withdrawal\s+request\s*[:\-]\s*([A-Za-z][\w'\-]+)\s*,\s*(boys|girls)\b[^\d]*?(\d+)", re.I)


# Common letters that NFKD leaves intact (no base+combining decomposition).
_TRANSLIT = str.maketrans({
    "ø": "o", "œ": "oe", "æ": "ae", "ł": "l", "đ": "d", "ð": "d",
    "þ": "th", "ß": "ss", "ı": "i", "ŋ": "n", "ħ": "h", "ĸ": "k",
})


def _norm_name(s: str) -> str:
    """Fold a name to a comparable form: strip accents/diacritics, drop
    apostrophes ("O'Brien" == "OBrien"), lowercase, and reduce any other
    punctuation/whitespace run to single spaces. 'Renée O'Brien' and
    'Renee OBrien' both fold to 'renee obrien'."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    # Letters that DON'T NFKD-decompose to base+combining (Nordic/Polish/Turkish/
    # …) would otherwise be dropped by the a-z filter below and shatter the token
    # — fold them to their plain-ASCII base so "Sørensen" == "Sorensen".
    s = s.lower().translate(_TRANSLIT).replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _fuzzy_name_match(roster: list, name: str, exclude_ids: frozenset = frozenset()):
    """Resolve a parsed name STRING to a UNIQUE roster player by normalized,
    order-independent token matching — so 'Quintero, Maya', 'Maya R. Quintero',
    'Renée O'Brien' (vs 'Renee OBrien'), and a multi-word surname ('Van Der
    Berg') all land on the same player. Two passes, each requiring a single hit
    (ambiguous → None, never guess):

      1. every token of the roster first AND last name appears among the parsed
         tokens (subset match — tolerant of a middle name/initial in between)
      2. the full last name is present and the first *initial* matches (handles
         'K. Hampton' vs a roster 'Katherine Hampton')
    """
    toks = set(_norm_name(name).split())
    if len(toks) < 2:
        return None

    def _candidates(initial_only: bool):
        out = []
        for r in roster:
            if r["id"] in exclude_ids:
                continue
            ftoks = set(_norm_name(r["first_name"] or "").split())
            ltoks = set(_norm_name(r["last_name"] or "").split())
            if not ftoks or not ltoks or not ltoks <= toks:
                continue  # the whole surname must be present
            if ftoks <= toks:
                out.append(r)
            elif initial_only:
                # the ACTUAL first initial (first char of the given name) — not
                # the alphabetically-first token, which mis-folds "Mary Beth".
                fi = _norm_name(r["first_name"] or "")[:1]
                if fi and any(t[:1] == fi for t in (toks - ltoks)):
                    out.append(r)
        return out

    exact = _candidates(initial_only=False)
    if len(exact) == 1:
        return exact[0]
    if not exact:
        loose = _candidates(initial_only=True)
        if len(loose) == 1:
            return loose[0]
    return None


def _detect_player_for(cur, tournament_id: int, subject: str, body: str,
                       from_address: str = "", exclude_ids: frozenset = frozenset()) -> dict:
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
    roster = [r for r in cur.fetchall() if r["id"] not in exclude_ids]

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
    # Candidates (labeled / number-before-name / bare runs) come back in ORDER
    # OF APPEARANCE — for doubles the email lists the requester FIRST, so the
    # first matching number decides the primary (not roster iteration order).
    ustas = usta_candidates(subject, f"{body}\n{from_address}")
    if ustas:
        by_usta = {r["usta_number"]: r for r in roster if r["usta_number"]}
        for num in ustas:
            if num in by_usta:
                return ret(by_usta[num], "usta")

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
    subj_last = [r for r in roster if r["last_name"] and _surname_present(r["last_name"], subject)]
    if len(subj_last) == 1:
        return ret(subj_last[0], "lastname_subject")

    # L7 — unique surname anywhere (subject + body + sender). Last resort; only
    # fires when exactly one roster surname appears, so club/parent senders that
    # share a player's surname resolve to that lone player.
    text_last = [r for r in roster if r["last_name"] and _surname_present(r["last_name"], text)]
    if len(text_last) == 1:
        return ret(text_last[0], "lastname")

    # L8 — fuzzy full-name match (normalized, order-independent) over every
    # person-name span the text mentions. Catches what the exact-substring
    # layers above miss: "Quintero, Maya" inversion, a middle name/initial
    # ("Maya R. Quintero"), accents ("Renée O'Brien"), or odd spacing — the
    # common reasons a doubles PARTNER goes unmatched. Names parsed alongside a
    # USTA # (extract_name_usta_pairs) are included too. Order of appearance, so
    # the requester (named first) still wins the primary slot; unique hit only.
    seen_norm = set()
    # The two names joined by a pairing connector are the most likely players —
    # try them first, then any other name span, then names beside a USTA #.
    name_cands = list(extract_doubles_pair(subject, body))
    name_cands += list(extract_names(subject, body))
    name_cands += [p["name"] for p in extract_name_usta_pairs(subject, body)]
    for nm in name_cands:
        key = _norm_name(nm)
        if key in seen_norm:
            continue
        seen_norm.add(key)
        r = _fuzzy_name_match(roster, nm)
        if r:
            return ret(r, "fuzzy_name")

    # L9 — OFF-ROSTER USTA match: the email's USTA # belongs to a player who
    # exists in the system but isn't entered in THIS tournament (so L1 missed
    # them). USTA #s are unique → high confidence; we never off-roster-match on a
    # bare name (too many collisions system-wide). The distinct `usta_offroster`
    # kind lets the UI flag it and offer "add to roster". Reaching here means no
    # roster player carried any of these USTA #s.
    if ustas:
        cur.execute(
            "SELECT id, usta_number, "
            "TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name "
            "FROM player WHERE usta_number = ANY(%s)",
            (ustas,),
        )
        offs = [r for r in cur.fetchall() if r["id"] not in exclude_ids]
        if len(offs) == 1:
            r = offs[0]
            return {"detected_player_id": r["id"], "detected_usta": r["usta_number"],
                    "detected_player_name": r["name"], "match_kind": "usta_offroster"}

    return {"detected_player_id": None, "detected_usta": None,
            "detected_player_name": None, "match_kind": None}


def _surname_present(surname: str, text: str) -> bool:
    """Whether `surname` appears in `text` as a SURNAME — used by the last-resort
    unique-surname layers (L6/L7). Rejects the one false-positive shape the real
    corpus produced: a signature where the roster surname is actually someone
    else's FIRST name followed by a middle initial — "Alexander R. Jordan" must
    not match the roster player whose surname is 'Alexander'. So an occurrence
    immediately followed by a middle initial ("<word> R.") doesn't count; the
    surname qualifies only if it appears at least once NOT in that position.
    Plain "Smith Withdrawal" or "<First> Alexander" still qualify."""
    for m in re.finditer(rf"\b{re.escape(surname)}\b", text, re.IGNORECASE):
        if not re.match(r"\s+[A-Z]\.", text[m.end():m.end() + 6]):
            return True
    return False


def _unique_firstname_match(cur, tournament_id, subject, body, exclude_ids):
    """Last-resort partner finder: in a doubles email the partner is sometimes
    referenced by FIRST name only ("…I don't have Mia's parent confirmation yet
    to pair them"). Match a roster first name that appears in the text — but ONLY
    when exactly one roster player qualifies (never guess between two), and
    case-SENSITIVELY so a name that doubles as a common word ("Will", "Grace",
    "May") doesn't match its lowercase use. Doubles-partner scoped (the caller
    only invokes it for that), so the precision bar can be lower than the general
    detector."""
    text = f"{subject or ''}\n{body or ''}"
    cur.execute(
        "SELECT p.id, p.usta_number, p.first_name, "
        "       TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) AS name "
        "FROM player p JOIN tournament_entry e ON e.player_id = p.id "
        "WHERE e.tournament_id = %s",
        (tournament_id,),
    )
    hits = [r for r in cur.fetchall()
            if r["id"] not in exclude_ids and r["first_name"]
            and re.search(rf"\b{re.escape(r['first_name'])}\b", text)]
    ids = {r["id"] for r in hits}
    return hits[0] if len(ids) == 1 else None


def _detect_pair_for(cur, tournament_id, subject, body, from_address, classification):
    """Multi-player detection for the classifications that name several players.

    - doubles: requester + ONE partner -> second pass with the primary excluded.
    - pairing_avoidance: a GROUP ("don't pair A with B and C") -> keep re-running
      the layered match, excluding everyone found so far, until it comes up dry
      (capped at 6 - beyond that it's matching noise, not a group).
    Other classifications keep both slots NULL."""
    d = _detect_player_for(cur, tournament_id, subject, body, from_address)
    partner = {"detected_partner_id": None, "detected_partner_name": None,
               "detected_partner_usta": None, "partner_match_kind": None}
    member_ids = None
    if classification == "doubles" and d["detected_player_id"]:
        p = _detect_player_for(cur, tournament_id, subject, body, from_address,
                               exclude_ids=frozenset({d["detected_player_id"]}))
        if p["detected_player_id"]:
            partner = {"detected_partner_id": p["detected_player_id"],
                       "detected_partner_name": p["detected_player_name"],
                       "detected_partner_usta": p["detected_usta"],
                       "partner_match_kind": p["match_kind"]}
        else:
            # The layered detector found no second full name / USTA #. Fall back
            # to a UNIQUE roster first name in the text — the partner is often
            # named only by first name ("…to pair them with Mia").
            fp = _unique_firstname_match(
                cur, tournament_id, subject, body, frozenset({d["detected_player_id"]}))
            if fp:
                partner = {"detected_partner_id": fp["id"], "detected_partner_name": fp["name"],
                           "detected_partner_usta": fp["usta_number"],
                           "partner_match_kind": "firstname"}
    elif classification == "pairing_avoidance" and d["detected_player_id"]:
        found = [d["detected_player_id"]]
        while len(found) < 6:
            nxt = _detect_player_for(cur, tournament_id, subject, body, from_address,
                                     exclude_ids=frozenset(found))
            if not nxt["detected_player_id"]:
                break
            found.append(nxt["detected_player_id"])
        if len(found) >= 2:          # one name isn't a group - leave NULL
            member_ids = found
    return d, partner, member_ids


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
            "SELECT id, tournament_id, subject, body, from_address, classification "
            "FROM email_message WHERE id = %s",
            (email_id,),
        )
        em = cur.fetchone()
        if em is None:
            raise HTTPException(status_code=404, detail="email not found")
        if em["tournament_id"] is None:
            raise HTTPException(status_code=400, detail="email has no tournament; assign one first")
        body_txt = _dec_body(em["body"])
        d, partner, member_ids = _detect_pair_for(cur, em["tournament_id"], em["subject"],
                                                   body_txt, em["from_address"],
                                                   em["classification"])
        # Re-evaluate the parsed USTA #(s) too — the classification may have
        # changed since import (e.g. now doubles -> keep BOTH numbers).
        if em["classification"] in ("doubles", "pairing_avoidance"):
            usta_text = ", ".join(extract_ustas(em["subject"], body_txt)) or None
        else:
            usta_text = extract_usta(em["subject"], body_txt)
        cur.execute(
            "UPDATE email_message SET detected_usta_text = %s WHERE id = %s",
            (usta_text, email_id),
        )
        cur.execute(
            "UPDATE email_message SET detected_player_id = %s, detected_match_kind = %s, "
            "detected_partner_id = %s, detected_member_ids = %s WHERE id = %s "
            "RETURNING (SELECT array_agg(TRIM(COALESCE(m.first_name,'') || ' ' || COALESCE(m.last_name,'')) "
            "                            ORDER BY array_position(detected_member_ids, m.id)) "
            "           FROM player m WHERE m.id = ANY(detected_member_ids)) AS member_names",
            (d["detected_player_id"], d["match_kind"],
             partner["detected_partner_id"], member_ids, email_id),
        )
        names = cur.fetchone()["member_names"]
        return {"email_id": email_id, **d, **partner,
                "detected_member_ids": member_ids, "detected_member_names": names}


@router.post("/bulk/detect-players", response_model=list[EmailDetectResult])
def bulk_detect_players(body: EmailBulkDetect, conn=Depends(db_dep)):
    out: list[dict] = []
    if not body.email_ids:
        return out
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tournament_id, subject, body, from_address, classification "
            "FROM email_message WHERE id = ANY(%s)",
            (body.email_ids,),
        )
        for em in cur.fetchall():
            if em["tournament_id"] is None:
                out.append({"email_id": em["id"], "detected_player_id": None,
                            "detected_usta": None, "detected_player_name": None,
                            "match_kind": None})
                continue
            d, partner, member_ids = _detect_pair_for(cur, em["tournament_id"], em["subject"],
                                                       _dec_body(em["body"]), em["from_address"],
                                                       em["classification"])
            cur.execute(
                "UPDATE email_message SET detected_player_id = %s, detected_match_kind = %s, "
                "detected_partner_id = %s, detected_member_ids = %s WHERE id = %s",
                (d["detected_player_id"], d["match_kind"],
                 partner["detected_partner_id"], member_ids, em["id"]),
            )
            out.append({"email_id": em["id"], **d, **partner,
                        "detected_member_ids": member_ids})
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


@router.post("/bulk/classify")
def bulk_classify(body: EmailBulkClassify, conn=Depends(db_dep)):
    """Run the local rule-based triage classifier over the selected emails and
    write each one's suggested classification. By default only 'unclassified'
    emails are touched (a TD's manual classification is never clobbered). Returns
    the new classification per changed email + a count, so the inbox can then run
    detect-players + populate to file them — the full bulk-triage chain."""
    if not body.email_ids:
        return {"classified": 0, "changed": [], "counts": {}}
    changed: list[dict] = []
    counts: dict = {}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, subject, body, classification FROM email_message WHERE id = ANY(%s)",
            (body.email_ids,),
        )
        rows = cur.fetchall()
        for em in rows:
            if body.only_unclassified and em["classification"] != "unclassified":
                continue
            cls = classify(em["subject"], _dec_body(em.get("body")))
            if cls == em["classification"]:
                continue
            cur.execute(
                "UPDATE email_message SET classification = %s WHERE id = %s",
                (cls, em["id"]),
            )
            changed.append({"id": em["id"], "classification": cls})
            counts[cls] = counts.get(cls, 0) + 1
    return {"classified": len(changed), "changed": changed, "counts": counts}


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
                # Per-row SAVEPOINT (P2 #10): without it the first SQL error
                # aborts the whole transaction — every later row would fail
                # with InFailedSqlTransaction and the request-end COMMIT would
                # silently roll back the rows already "filed".
                with savepoint(cur):
                    # Append each target's locally-parsed extras (reason /
                    # division / events) after the core params, in the
                    # registry's declared order, so bulk fills the same fields
                    # single-file does (no LLM).
                    extras = [_EXTRACTORS[name](em) for name in target.get("extract", [])]
                    cur.execute(target["sql"], (tid, pid, em["id"], *extras))
                    if cur.rowcount > 0:
                        filed_count += 1
                        mark_email_filed(cur, em["id"], em["classification"])
                    else:
                        skipped.append({"id": em["id"], "reason": f"{target['label']} already exists"})
            except psycopg.Error as e:
                skipped.append({"id": em["id"], "reason": str(e).splitlines()[0][:120]})
    return {"filed": filed_count, "skipped": skipped}


@router.post("/bulk/triage")
def bulk_triage(body: EmailBulkClassify, conn=Depends(db_dep)):
    """One-click triage: run the whole chain over the selected emails in one
    request — classify (local rules) → detect players → populate the target
    lists — and return a combined summary so the TD clears the unfiled queue in
    a single action. Reuses the three bulk handlers on the same connection, so it
    can never drift from running them individually."""
    ids = body.email_ids
    if not ids:
        return {"classified": 0, "detected": 0, "filed": 0,
                "classify_counts": {}, "skipped": []}
    classify_res = bulk_classify(
        EmailBulkClassify(email_ids=ids, only_unclassified=body.only_unclassified), conn)
    detect_res = bulk_detect_players(EmailBulkDetect(email_ids=ids), conn)
    detected = sum(1 for d in detect_res if d.get("detected_player_id"))
    populate_res = bulk_populate(EmailBulkPopulate(email_ids=ids), conn)
    return {
        "classified": classify_res["classified"],
        "classify_counts": classify_res["counts"],
        "detected": detected,
        "filed": populate_res["filed"],
        "skipped": populate_res["skipped"],
    }
