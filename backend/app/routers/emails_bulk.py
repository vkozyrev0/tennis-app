"""Bulk inbox actions (C2 split from routers/emails.py).

Same prefix ``/api/emails`` as the main emails router so paths are unchanged.
Mounted separately in ``main.py`` with the admin dependency.
"""
import psycopg
from fastapi import APIRouter, Depends, HTTPException

from ..bulk_ops import savepoint
from ..crypto import decrypt as _dec_body
from ..db import db_dep
from ..email_detect import _detect_pair_for
from ..email_extract import (
    extract_age_division,
    extract_avoid_day,
    extract_avoid_time,
    extract_events,
    extract_withdrawal_reason,
)
from ..email_stamp import _stamp_extracted_fields
from ..email_targets import (
    POPULATE_TARGETS,
    SINGLE_FILE_ONLY_KEYS,
)
from ..models import (
    EmailBulkClassify,
    EmailBulkDetect,
    EmailBulkPopulate,
    EmailBulkReassign,
    EmailBulkStatus,
    EmailDetectResult,
)
from ..playerops import mark_email_filed
from ..triage import classify

router = APIRouter(prefix="/api/emails", tags=["emails"])

# Maps POPULATE_TARGETS extract field names → functions (bulk_populate).
# Registry-consistency test imports this via routers.emails re-export.
_EXTRACTORS = {
    "reason": lambda em: extract_withdrawal_reason(em["subject"], em["body"]),
    "division": lambda em: extract_age_division(em["subject"], em["body"]),
    "events": lambda em: extract_events(em["subject"], em["body"]),
    "avoid_day": lambda em: extract_avoid_day(em["subject"], em["body"]),
    "avoid_time": lambda em: extract_avoid_time(em["subject"], em["body"]),
}

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
            body_txt = _dec_body(em["body"])
            d, partner, member_ids = _detect_pair_for(cur, em["tournament_id"], em["subject"],
                                                       body_txt, em["from_address"],
                                                       em["classification"])
            cur.execute(
                "UPDATE email_message SET detected_player_id = %s, detected_match_kind = %s, "
                "detected_partner_id = %s, detected_member_ids = %s WHERE id = %s",
                (d["detected_player_id"], d["match_kind"],
                 partner["detected_partner_id"], member_ids, em["id"]),
            )
            _stamp_extracted_fields(
                cur, em["id"], em["subject"], body_txt, em["classification"],
                d.get("detected_player_id"),
            )
            out.append({"email_id": em["id"], **d, **partner,
                        "detected_member_ids": member_ids})
    return out


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
            body_txt = _dec_body(em.get("body"))
            cls = classify(em["subject"], body_txt)
            if cls == em["classification"]:
                continue
            cur.execute(
                "UPDATE email_message SET classification = %s WHERE id = %s",
                (cls, em["id"]),
            )
            # Classification drives which extractors apply — re-stamp now so the
            # next list GET does not recompute (and withdrawal reason appears).
            cur.execute(
                "SELECT detected_player_id FROM email_message WHERE id = %s",
                (em["id"],),
            )
            pid = cur.fetchone()["detected_player_id"]
            _stamp_extracted_fields(cur, em["id"], em["subject"], body_txt, cls, pid)
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

