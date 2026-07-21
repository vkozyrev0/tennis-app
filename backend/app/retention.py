"""Retention sweep (PII hardening H3.1/H3.3 — docs/pii-hardening-plan.md).

A single, schedule-driven entry point that enforces the written retention policy
by erasing minors'/parents' free-text PII once it is no longer needed. Designed
to be run on a timer (cron / systemd) in production; here it is exposed as an
admin endpoint with a **dry-run** mode and **count-only** results (it logs how
many rows it would touch, never the data).

Current rule (extend as more stores are covered):
- **Filed-email free text** (`email_message.body/subject/from_address`) — the
  highest-risk store — is redacted once the tournament it belongs to **concluded**
  (`play_end_date`) more than `EMAIL_RETENTION_DAYS` ago. Emails with no
  tournament fall back to `received_at`. The provenance row (message_id,
  classification, detected-player link, status) is kept.

The manual `POST /api/emails/purge` (received-at based) remains a separate ad-hoc
tool; this sweep is the policy-driven job.
"""
import os

# Default window; override with EMAIL_RETENTION_DAYS. The *written policy* value.
DEFAULT_EMAIL_RETENTION_DAYS = int(os.getenv("EMAIL_RETENTION_DAYS", "90"))

# Eligible = filed, still has free text, and its tournament concluded (or, if
# untournamented, it was received) more than N days ago.
_ELIGIBLE_EMAIL_IDS = (
    "SELECT e.id FROM email_message e "
    "LEFT JOIN tournament t ON t.id = e.tournament_id "
    "WHERE e.status = 'filed' "
    "  AND (e.body IS NOT NULL OR e.subject IS NOT NULL OR e.from_address IS NOT NULL) "
    "  AND COALESCE(t.play_end_date, e.received_at::date) < current_date - %s::int"
)


def policy() -> dict:
    """The configured retention schedule (the machine-readable 'written policy')."""
    return {
        "email_body_retention_days": DEFAULT_EMAIL_RETENTION_DAYS,
        "rules": [
            {
                "target": "email_bodies",
                "what": "filed-email body/subject/from_address (free-text PII)",
                "trigger": "tournament concluded (play_end_date), else received_at",
                "after_days": DEFAULT_EMAIL_RETENTION_DAYS,
                "action": "redact (provenance row kept)",
            }
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
    cur.execute(_ELIGIBLE_EMAIL_IDS, (days,))
    ids = [r["id"] for r in cur.fetchall()]
    if ids and not dry_run:
        cur.execute(
            "UPDATE email_message SET body = NULL, subject = NULL, from_address = NULL "
            "WHERE id = ANY(%s)",
            (ids,),
        )
    return {
        "dry_run": dry_run,
        "older_than_days": days,
        "results": [{"target": "email_bodies", "eligible": len(ids),
                     "redacted": 0 if dry_run else len(ids)}],
        "total_eligible": len(ids),
    }
