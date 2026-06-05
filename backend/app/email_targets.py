"""Canonical registry of Part B email classifications and their filing targets.

**Single source of truth** for "which list does an inbox email get filed into."
Shared by every layer so a classification key can't drift between them:

  - ``triage.classify()``         → produces these ``key`` values (plus ``"other"``)
  - ``emails.bulk_populate``      → builds its INSERT map (:data:`POPULATE_TARGETS`)
                                    from ``bulk_sql`` here, so a typo'd key is
                                    impossible (the bug where the populate map said
                                    ``"scheduling"`` while everything else used
                                    ``"scheduling_avoidance"`` and every such email
                                    was silently skipped).
  - ``GET /api/emails/targets``   → the frontend builds its "File as …" menu +
                                    labels from this list, joining each key to its
                                    local form/tab DOM wiring.

Each entry:
  ``key``       the canonical classification value (stored on ``email_message``).
  ``label``     the TD-facing name (used in menus, skip messages, chips).
  ``bulk_sql``  the server-side INSERT for the bulk "Populate lists →" action,
                or ``None`` when a row needs fields a single email + detected
                player can't supply — **doubles** (needs ``wants_random`` or
                ``partner_usta``) and **pairing avoidance** (needs a group of 2+
                members). Those stay *single-file only* (filed via the form).
"""

# Order = the order the frontend renders the menu / chips.
EMAIL_TARGETS = [
    {
        "key": "late_entry",
        "label": "Late entry",
        # `extract` names the locally-parsed fields appended (in order) after the
        # core (tournament_id, player_id, source_email_id) params — see
        # _EXTRACTORS in routers/emails.py. Keeps single-file and bulk in sync.
        "bulk_sql": (
            "INSERT INTO late_entry "
            "(tournament_id, player_id, source_email_id, age_division, events) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id"
        ),
        # Correction auto-rewrite: re-point an existing row (matched by the amended
        # email's source_email_id) + re-apply the parsed fields. Params:
        # (new_source_email_id, *extract values, old_source_email_id).
        "amend_sql": (
            "UPDATE late_entry SET source_email_id = %s, age_division = %s, events = %s "
            "WHERE source_email_id = %s RETURNING id"
        ),
        "extract": ["division", "events"],
    },
    {
        "key": "withdrawal",
        "label": "Withdrawal",
        # reason + events are auto-extracted from the email (see emails.py).
        "bulk_sql": (
            "INSERT INTO withdrawal "
            "(tournament_id, player_id, source_email_id, reason, events) "
            "VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING RETURNING id"
        ),
        "amend_sql": (
            "UPDATE withdrawal SET source_email_id = %s, reason = %s, events = %s "
            "WHERE source_email_id = %s RETURNING id"
        ),
        "extract": ["reason", "events"],
    },
    {
        "key": "scheduling_avoidance",
        "label": "Scheduling avoid.",
        "bulk_sql": (
            "INSERT INTO scheduling_avoidance "
            "(tournament_id, player_id, source_email_id, avoid_day, avoid_time_range) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id"
        ),
        "amend_sql": (
            "UPDATE scheduling_avoidance SET source_email_id = %s, avoid_day = %s, "
            "avoid_time_range = %s WHERE source_email_id = %s RETURNING id"
        ),
        "extract": ["avoid_day", "avoid_time"],
    },
    {
        "key": "division_flex",
        "label": "Division flex",
        "bulk_sql": (
            "INSERT INTO division_flexibility (tournament_id, player_id, source_email_id) "
            "VALUES (%s, %s, %s) RETURNING id"
        ),
        "amend_sql": (
            "UPDATE division_flexibility SET source_email_id = %s "
            "WHERE source_email_id = %s RETURNING id"
        ),
        "extract": [],
    },
    {
        "key": "hotel",
        "label": "Player hotel",
        "bulk_sql": (
            "INSERT INTO player_hotel_stay (tournament_id, player_id, source_email_id) "
            "VALUES (%s, %s, %s) RETURNING id"
        ),
        "amend_sql": (
            "UPDATE player_hotel_stay SET source_email_id = %s "
            "WHERE source_email_id = %s RETURNING id"
        ),
        "extract": [],
    },
    # --- fileable, but NOT bulk-populatable (need more than player+tournament) ---
    {"key": "pairing_avoidance", "label": "Pairing avoid.", "bulk_sql": None},
    {"key": "doubles", "label": "Doubles", "bulk_sql": None},
]

# Every classification that can be filed into a list (has a target at all).
FILEABLE_KEYS = [t["key"] for t in EMAIL_TARGETS]

# Bulk-populate map keyed by classification — only entries with a bulk_sql.
# Same shape the inline _POPULATE_TARGETS used to have: {key: {"sql", "label"}}.
POPULATE_TARGETS = {
    t["key"]: {"sql": t["bulk_sql"], "label": t["label"],
               "extract": t.get("extract", []), "amend_sql": t.get("amend_sql")}
    for t in EMAIL_TARGETS
    if t["bulk_sql"] is not None
}

# Keys that are fileable individually but not in bulk — used to give the bulk
# action an *informative* skip reason instead of a generic "no target".
SINGLE_FILE_ONLY_KEYS = [t["key"] for t in EMAIL_TARGETS if t["bulk_sql"] is None]


def public_targets() -> list[dict]:
    """The registry as the frontend consumes it: key, label, and a `bulk` flag."""
    return [
        {"key": t["key"], "label": t["label"], "bulk": t["bulk_sql"] is not None}
        for t in EMAIL_TARGETS
    ]
