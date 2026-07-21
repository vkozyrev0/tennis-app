"""H4.2 — gate bulk export of minors' PII (docs/pii-hardening-plan.md §H4.2).

Classifies export *resource* names (the same strings used by export_audit and
SPA filenames) so we can:

1. Require ``user_account.can_export_pii`` for full minors-PII exports.
2. Allow **redacted** exports (sensitive columns stripped) without that flag.
3. Keep operational / officials-only CSVs (payroll, rates, sites) ungated.

Client-side grids already hold decrypted rows in memory; this gate is a
*bulk-file* control + accountability hook, not a substitute for view RBAC.
"""
from __future__ import annotations

from typing import Any, Iterable

from fastapi import HTTPException

# Resource name fragments / exact names that carry junior / parent PII.
# Matching is case-insensitive substring OR exact (normalized).
_MINORS_PII_EXACT = frozenset({
    "players",
    "player",
    "roster",
    "emails",
    "email",
    "late_entries",
    "late-entries",
    "withdrawals",
    "scheduling-avoidances",
    "scheduling_avoidances",
    "division-flexibility",
    "division_flexibility",
    "pairing-avoidances",
    "pairing_avoidances",
    "doubles",
    "doubles_requests",
    "doubles-requests",
    "player-hotels",
    "player_hotels",
    "player_hotel",
    "tshirts",
    "t-shirts",
    "adult-lists",  # still players on adult events — contact-adjacent
    "adult_lists",
})

# Prefixes / substrings that mark sign-in sheets and other player name dumps.
_MINORS_PII_PREFIXES = (
    "sign-in",
    "signin",
    "players",
    "roster",
    "emails",
)

# Column headers (case-insensitive) stripped in redacted mode.
REDACT_HEADERS = frozenset({
    "emails", "email", "phones", "phone", "birthdate", "dob",
    "year_of_birth", "year-of-birth", "body", "from_address", "from",
    "parent_email", "parent_phone", "dietary_preference", "dietary",
})


def normalize_resource(resource: str | None) -> str:
    return (resource or "").strip().lower().replace(" ", "_")


def is_minors_pii_resource(resource: str | None) -> bool:
    """True when this export is treated as bulk minors' (or parent-linked) PII."""
    r = normalize_resource(resource)
    if not r:
        return False
    # Strip .csv and path-ish noise
    r = r.removesuffix(".csv")
    base = r.split("/")[-1]
    if base in _MINORS_PII_EXACT or r in _MINORS_PII_EXACT:
        return True
    for p in _MINORS_PII_PREFIXES:
        if base.startswith(p) or p in base:
            return True
    return False


def require_can_export_pii(user: dict, *, redacted: bool = False) -> None:
    """Raise 403 if this user may not perform a full minors-PII export.

    Redacted exports skip the capability check (still need admin session).
    """
    if redacted:
        return
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    if user.get("can_export_pii") is False:
        raise HTTPException(
            status_code=403,
            detail="full PII export disabled for this account "
                   "(can_export_pii=false). Use a redacted export or ask "
                   "another admin to grant export permission.",
        )


def redact_matrix(matrix: list[list[Any]]) -> list[list[Any]]:
    """Drop REDACT_HEADERS columns from a [header, ...rows] matrix.

    If the first row is not a header list, returns the matrix unchanged.
    """
    if not matrix or not isinstance(matrix[0], (list, tuple)):
        return matrix
    headers = list(matrix[0])
    drop_idx = {
        i for i, h in enumerate(headers)
        if str(h).strip().lower().replace(" ", "_") in REDACT_HEADERS
        or str(h).strip().lower() in REDACT_HEADERS
    }
    if not drop_idx:
        return matrix
    out: list[list[Any]] = []
    for row in matrix:
        if not isinstance(row, (list, tuple)):
            out.append(row)
            continue
        out.append([c for i, c in enumerate(row) if i not in drop_idx])
    return out


def redact_row_dict(row: dict, *, keys: Iterable[str] | None = None) -> dict:
    """Return a shallow copy of row with sensitive keys set to None / removed."""
    drop = {k.lower() for k in (keys or REDACT_HEADERS)}
    return {k: (None if k.lower() in drop else v) for k, v in row.items()}
