"""Part B review inbox: inbound parent/player email, filed by a human (D5/§5.1).

C2 (2026-07-21): bulk actions live in ``routers/emails_bulk.py``; player
detection helpers in ``app/email_detect.py``; field stamping in
``app/email_stamp.py``. This module keeps CRUD + single detect + list targets.
Back-compat re-exports preserve existing test/importer import paths.
"""
import json

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from ..crypto import decrypt as _dec_body
from ..crypto import encrypt as _enc_body
from ..db import db_dep
from ..email_detect import (  # noqa: F401 — public re-exports for tests/importer
    _detect_pair_for,
    _detect_player_for,
    _fuzzy_name_match,
    _norm_name,
    _surname_present,
    _unique_firstname_match,
)
from ..email_extract import (  # noqa: F401 — re-export for importer/tests
    compute_extracted_fields,
    extract_age_division,
    extract_avoid_day,
    extract_avoid_time,
    extract_doubles_pair,
    extract_events,
    extract_name_usta_pairs,
    extract_names,
    extract_surname_pair,
    extract_usta,
    extract_ustas,
    extract_withdraw_name,
    extract_withdrawal_reason,
    usta_candidates,
)
from ..email_stamp import _apply_extracted_to_row, _stamp_extracted_fields
from ..email_targets import POPULATE_TARGETS, public_targets
from ..models import (
    EmailAmend,
    EmailCreate,
    EmailDetectResult,
    EmailOut,
    EmailUpdate,
)
from ..playerops import mark_email_filed
from ..query_helpers import like_escape, paged_select
from ..triage import classify

# C2: re-export bulk extractors for registry-consistency tests.
from .emails_bulk import _EXTRACTORS  # noqa: E402, F401

router = APIRouter(prefix="/api/emails", tags=["emails"])

# SELECT joins LEFT to player so detected_player_name + detected_usta render
# inline in the inbox grid alongside the classification.
_COLS = (
    "e.id, e.tournament_id, e.message_id, e.received_at, e.from_address, "
    "e.to_address, e.ingest_source, "
    "e.subject, e.body, e.classification, e.status, e.detected_player_id, "
    "e.detected_match_kind, e.detected_usta_text, "
    "e.detected_reason, e.detected_division, e.detected_events, "
    "e.detected_name_pairs, e.detected_avoid_day, e.detected_avoid_time, "
    "e.detected_text_ready, "
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
    "e.amends_email_id, am.subject AS amends_subject, "
    "EXISTS (SELECT 1 FROM email_message s WHERE s.amends_email_id = e.id) AS superseded"
)
_FROM = ("FROM email_message e "
         "LEFT JOIN player p ON p.id = e.detected_player_id "
         "LEFT JOIN player pp ON pp.id = e.detected_partner_id "
         "LEFT JOIN tournament tn ON tn.id = e.tournament_id "
         "LEFT JOIN email_message am ON am.id = e.amends_email_id")


def _finalize_email_row(cur, r: dict) -> dict:
    """Decrypt body; ensure extracted fields are present (lazy-stamp legacy)."""
    r["body"] = _dec_body(r.get("body"))
    ready = r.pop("detected_text_ready", True)
    pairs = r.get("detected_name_pairs")
    if isinstance(pairs, str):
        try:
            r["detected_name_pairs"] = json.loads(pairs)
        except (TypeError, ValueError):
            r["detected_name_pairs"] = None
    if not ready:
        fields = _stamp_extracted_fields(
            cur, r["id"], r.get("subject"), r.get("body"),
            r.get("classification"), r.get("detected_player_id"),
        )
        _apply_extracted_to_row(r, fields)
    return r


@router.get("", response_model=list[EmailOut])
def list_emails(response: Response, tournament_id: int | None = None,
                status: str | None = None, q: str | None = None,
                unmatched: bool | None = None,
                limit: int | None = None, offset: int = 0, conn=Depends(db_dep)):
    """Server-side filtered/paged inbox. `q` searches subject + from_address +
    classification + division + matched player name/USTA + parsed USTA text —
    but NOT the body itself, which is encrypted at rest (H2).
    `limit`/`offset` page the result; the full match count is in the
    `X-Total-Count` header. With no limit the whole (filtered) set is returned.

    Derived detect fields are **read from columns** (stamped on write/detect).
    Pre-0051 rows get a one-time lazy stamp when `detected_text_ready` is false.
    """
    clauses, params = [], []
    if tournament_id is not None:
        clauses.append("e.tournament_id = %s"); params.append(tournament_id)
    if status is not None:
        clauses.append("e.status = %s"); params.append(status)
    if unmatched:
        # Detection gap: no roster player matched. Feeds the unmatched drilldown.
        clauses.append("e.detected_player_id IS NULL")
    if q:
        # Metadata + stamped fields only (body is encrypted — not ILIKE'd).
        clauses.append(
            "(e.subject ILIKE %s OR e.from_address ILIKE %s "
            "OR e.classification ILIKE %s OR e.detected_division ILIKE %s "
            "OR e.detected_usta_text ILIKE %s OR p.usta_number ILIKE %s "
            "OR TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) ILIKE %s)"
        )
        eq = like_escape(q)
        params += [f"%{eq}%"] * 7
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        rows = paged_select(cur, response, cols=_COLS, from_sql=_FROM,
                            where=where, params=params,
                            order_by=" ORDER BY e.received_at DESC",
                            limit=limit, offset=offset)
        for r in rows:
            _finalize_email_row(cur, r)
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
            # Stamp extracted text fields so the list never re-parses (D9).
            # Manual paste path: ingest_source defaults to 'manual' in the schema.
            fields = compute_extracted_fields(
                body.subject, body.body, "unclassified", has_detected_player=False,
            )
            params = {
                **body.model_dump(),
                "body": _enc_body(body.body),
                **fields,
                "detected_name_pairs": json.dumps(fields["detected_name_pairs"])
                if fields["detected_name_pairs"] is not None else None,
            }
            cur.execute(
                """
                INSERT INTO email_message
                    (tournament_id, message_id, from_address, to_address,
                     subject, body, detected_usta_text, detected_reason,
                     detected_division, detected_events, detected_name_pairs,
                     detected_avoid_day, detected_avoid_time, detected_text_ready,
                     ingest_source)
                VALUES
                    (%(tournament_id)s, %(message_id)s, %(from_address)s, %(to_address)s,
                     %(subject)s, %(body)s, %(detected_usta_text)s, %(detected_reason)s,
                     %(detected_division)s, %(detected_events)s,
                     %(detected_name_pairs)s::jsonb,
                     %(detected_avoid_day)s, %(detected_avoid_time)s, TRUE,
                     'manual')
                RETURNING id
                """,
                params,
            )
            new_id = cur.fetchone()["id"]
            cur.execute(f"SELECT {_COLS} {_FROM} WHERE e.id = %s", (new_id,))
            return _finalize_email_row(cur, cur.fetchone())
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
            WHERE id = %(id)s RETURNING id, subject, body
            """,
            {**body.model_dump(), "id": email_id},
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="email not found")
        # Classification / player change can flip which extractors apply
        # (reason only on withdrawal, name-pairs on doubles, …).
        _stamp_extracted_fields(
            cur, email_id, row["subject"], _dec_body(row.get("body")),
            body.classification, body.detected_player_id,
        )
        cur.execute(f"SELECT {_COLS} {_FROM} WHERE e.id = %s", (email_id,))
        return _finalize_email_row(cur, cur.fetchone())


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
        return _finalize_email_row(cur, cur.fetchone())


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
        # Re-stamp extracted text (USTA(s), name pairs, division, …) after
        # detection — player presence affects withdrawal name-pair fallback.
        _stamp_extracted_fields(
            cur, email_id, em["subject"], body_txt, em["classification"],
            d.get("detected_player_id"),
        )
        return {"email_id": email_id, **d, **partner,
                "detected_member_ids": member_ids, "detected_member_names": names}

@router.get("/targets")
def list_targets():
    """The canonical classification→list registry the frontend builds its
    "File as …" menu + labels from (single source of truth — see
    ``app/email_targets.py``)."""
    return public_targets()

