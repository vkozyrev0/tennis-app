"""Retention sweep (PII hardening H3.1/H3.3 — docs/pii-hardening-plan.md).

A single, schedule-driven entry point that enforces the written retention policy
by erasing minors'/parents' free-text PII once it is no longer needed. Designed
to be run on a timer (cron / systemd) in production; here it is exposed as an
admin endpoint with a **dry-run** mode and **count-only** results (it logs how
many rows it would touch, never the data).

Current rule (extend as more stores are covered):
- **Filed-email free text and derived PII** (`email_message.body/subject/
  from_address/to_address`, `detected_usta_text`, `detected_name_pairs`,
  `detected_reason`) — the highest-risk store — is redacted once the tournament
  it belongs to **concluded** (`play_end_date`) more than
  `EMAIL_RETENTION_DAYS` ago. Emails with no tournament fall back to
  `received_at`. The provenance row (message_id, classification, detected-player
  link, status) is kept.
- **Inbox people** staged from a redacted email are deleted; they are a
  transient parsed list, and a promoted copy already lives on `player`.

The manual `POST /api/emails/purge` (received-at based) remains a separate ad-hoc
tool; this sweep is the policy-driven job.
"""
import os

from .clock import today_venue


def _parse_days(raw: str | None) -> int:
    """Parse the retention window; a malformed value falls back to 90 instead
    of preventing the app from importing."""
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return 90


# Default window; override with EMAIL_RETENTION_DAYS. The *written policy* value.
DEFAULT_EMAIL_RETENTION_DAYS = _parse_days(os.getenv("EMAIL_RETENTION_DAYS", "90"))

# Eligible = filed, still has free text, and its tournament concluded (or, if
# untournamented, it was received) more than N days ago. The cutoff date comes
# from the venue clock (D25), not the container's UTC `current_date`.
_ELIGIBLE_EMAIL_IDS = (
    "SELECT e.id FROM email_message e "
    "LEFT JOIN tournament t ON t.id = e.tournament_id "
    "WHERE e.status = 'filed' "
    "  AND (e.body IS NOT NULL OR e.subject IS NOT NULL OR e.from_address IS NOT NULL "
    "       OR e.to_address IS NOT NULL OR e.detected_usta_text IS NOT NULL "
    "       OR e.detected_name_pairs IS NOT NULL OR e.detected_reason IS NOT NULL) "
    "  AND COALESCE(t.play_end_date, e.received_at::date) < %s::date - %s::int"
)


def policy() -> dict:
    """The configured retention schedule (the machine-readable 'written policy')."""
    return {
        "email_body_retention_days": DEFAULT_EMAIL_RETENTION_DAYS,
        "rules": [
            {
                "target": "email_bodies",
                "what": ("filed-email body/subject/from_address/to_address and "
                         "detected_usta_text/name_pairs/reason (PII)"),
                "trigger": "tournament concluded (play_end_date), else received_at",
                "after_days": DEFAULT_EMAIL_RETENTION_DAYS,
                "action": "redact (provenance row kept)",
            },
            {
                "target": "import_staging",
                "what": "staged import batches (PII values are encrypted at rest)",
                "trigger": "upload created_at",
                "after_days": DEFAULT_EMAIL_RETENTION_DAYS,
                "action": "delete batch + rows",
            },
        ],
        # Cross-link: under-13 gate + residual-plaintext decision live on the
        # COPPA surface (audit D16), not in the retention day-count schedule.
        "coppa_policy": "/api/coppa/policy",
        "coppa_doc": "docs/coppa-policy.md",
    }


def run_retention(cur, *, older_than_days: int | None = None, dry_run: bool = True) -> dict:
    """Apply the retention policy. With dry_run=True, only counts what is eligible
    (nothing is modified). Returns a count-only report."""
    days = DEFAULT_EMAIL_RETENTION_DAYS if older_than_days is None else older_than_days
    # Guard the footgun: a negative window makes the cutoff `current_date - (-N)`
    # = a FUTURE date, which would match (and, when not dry-run, redact) EVERY
    # filed email — including mail still inside its retention window. The manual
    # /emails/purge endpoint already refuses this; the unattended policy sweep
    # must too (it's the one wired to a scheduler).
    if days < 0:
        raise ValueError("older_than_days must be >= 0")
    today = today_venue()
    cur.execute(_ELIGIBLE_EMAIL_IDS, (today, days))
    ids = [r["id"] for r in cur.fetchall()]
    cur.execute(
        "SELECT count(*) AS n FROM import_batch WHERE created_at < %s::date - %s::int",
        (today, days),
    )
    import_batches = cur.fetchone()["n"]
    inbox_people = 0
    if ids and not dry_run:
        cur.execute(
            "UPDATE email_message SET body = NULL, subject = NULL, from_address = NULL, "
            "to_address = NULL, detected_usta_text = NULL, detected_name_pairs = NULL, "
            "detected_reason = NULL WHERE id = ANY(%s)",
            (ids,),
        )
        cur.execute("DELETE FROM inbox_person WHERE source_email_id = ANY(%s)", (ids,))
        inbox_people = cur.rowcount
    if import_batches and not dry_run:
        cur.execute(
            "DELETE FROM import_batch WHERE created_at < %s::date - %s::int",
            (today, days),
        )
    return {
        "dry_run": dry_run,
        "older_than_days": days,
        "results": [
            {"target": "email_bodies", "eligible": len(ids),
             "redacted": 0 if dry_run else len(ids)},
            {"target": "inbox_people", "eligible": len(ids),
             "redacted": 0 if dry_run else inbox_people},
            {"target": "import_staging", "eligible": import_batches,
             "redacted": 0 if dry_run else import_batches},
        ],
        "total_eligible": len(ids),
    }
