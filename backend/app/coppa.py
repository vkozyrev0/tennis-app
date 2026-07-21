"""Thin COPPA posture for junior (under-13) player data — audit D16.

Companion docs: docs/coppa-policy.md, docs/pii-hardening-plan.md.

**Decision (2026-07-20):** residual *plaintext* for name / USTA # / city / state
is accepted so catalog search stays SQL-simple. Highest-risk fields
(email body, player emails/phones/birthdate) stay Fernet-encrypted. Under-13
rows are still COPPA-covered when knowingly stored — so storage of a birthdate
that implies age < 13 is **gated** by ``ALLOW_UNDER13_PII``:

- unset + dev/test  → allowed (POC seed, suite, local demos)
- unset + prod      → refused (403) until the operator opts in
- ``1`` / true      → allowed in any ENV (explicit acceptance of residual risk)
- ``0`` / false     → refused in any ENV

Missing birthdate is *not* blocked (age unknown to the app); the written policy
requires the TD not to use that as an evasion when they know the player is under 13.
"""
from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any

from fastapi import HTTPException

from .config import settings

# COPPA's bright line (16 CFR Part 312): under 13.
UNDER13_AGE = 13

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def allow_under13_pii() -> bool:
    """Whether writes may store a birthdate that implies age < 13."""
    raw = os.getenv("ALLOW_UNDER13_PII", "").strip().lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    # Auto: open in POC environments so seed/tests work; closed in prod.
    return not settings.is_prod()


def _as_date(value: date | datetime | str | None) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value).strip()
    if not s:
        return None
    # Accept YYYY-MM-DD or bare year.
    if len(s) == 4 and s.isdigit():
        return date(int(s), 1, 1)
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def conservative_birth_anchor(
    birthdate: date | datetime | str | None,
    precision: str | None = None,
) -> date | None:
    """Date used for age math.

    Year-only birthdates are stored as ``YYYY-01-01`` with
    ``birthdate_precision='year'``. For under-13 *blocking* we assume the
    **latest** possible birthday in that year (Dec 31) so we never under-count
    age and miss a still-under-13 player.
    """
    d = _as_date(birthdate)
    if d is None:
        return None
    prec = (precision or "day").strip().lower()
    if prec == "year" or (isinstance(birthdate, str) and len(str(birthdate).strip()) == 4):
        return date(d.year, 12, 31)
    return d


def age_years(
    birthdate: date | datetime | str | None,
    *,
    precision: str | None = None,
    as_of: date | None = None,
) -> int | None:
    """Completed years of age on ``as_of`` (default: today), or None if unknown."""
    anchor = conservative_birth_anchor(birthdate, precision)
    if anchor is None:
        return None
    today = as_of or date.today()
    years = today.year - anchor.year
    if (today.month, today.day) < (anchor.month, anchor.day):
        years -= 1
    return years


def is_under13(
    birthdate: date | datetime | str | None,
    *,
    precision: str | None = None,
    as_of: date | None = None,
) -> bool:
    """True only when birthdate is known and age is strictly under 13."""
    years = age_years(birthdate, precision=precision, as_of=as_of)
    return years is not None and years < UNDER13_AGE


def under13_block_detail() -> str:
    return (
        f"under-{UNDER13_AGE} player data is blocked (COPPA / audit D16). "
        "Set ALLOW_UNDER13_PII=1 to accept residual plaintext names/USTA # "
        "under the written policy in docs/coppa-policy.md, or omit/clear "
        "birthdate until the player is 13+."
    )


def refuse_under13_birthdate(
    birthdate: date | datetime | str | None,
    *,
    precision: str | None = None,
    as_of: date | None = None,
) -> None:
    """Raise HTTP 403 when storing this birthdate would introduce under-13 PII
    and the operator has not opted in. No-op when birthdate is missing or age ≥ 13.
    """
    if not is_under13(birthdate, precision=precision, as_of=as_of):
        return
    if allow_under13_pii():
        return
    raise HTTPException(status_code=403, detail=under13_block_detail())


def policy() -> dict[str, Any]:
    """Machine-readable COPPA / minors-PII posture (audit D16 + H3 retention)."""
    allowed = allow_under13_pii()
    raw = os.getenv("ALLOW_UNDER13_PII", "").strip()
    mode = "explicit_allow" if raw.lower() in _TRUE else (
        "explicit_deny" if raw.lower() in _FALSE else (
            "auto_dev_allow" if allowed else "auto_prod_deny"
        )
    )
    return {
        "doc": "docs/coppa-policy.md",
        "under13_age": UNDER13_AGE,
        "allow_under13_pii": allowed,
        "allow_under13_mode": mode,
        "allow_under13_env": "ALLOW_UNDER13_PII",
        "decision": {
            "residual_plaintext": [
                "player.first_name", "player.last_name", "player.usta_number",
                "player.city", "player.state", "player.district", "player.section",
                "email_message.subject", "email_message.from_address",
            ],
            "encrypted_at_rest": [
                "email_message.body",
                "player.emails", "player.phones", "player.birthdate",
            ],
            "rationale": (
                "Names and USTA # power ILIKE catalog search and roster matching; "
                "encrypting them would require blind indexes or app-side scan. "
                "Highest-risk free text and contact/DOB stay Fernet-encrypted. "
                "Disk/volume encryption (H2.1) is still required for shared hosts."
            ),
            "under13_gate": (
                "Writes that set a birthdate implying age < 13 are refused unless "
                "ALLOW_UNDER13_PII allows them. Opt-in is the explicit acceptance "
                "of residual plaintext under this policy."
            ),
        },
        "controls": {
            "rbac": "admin session for catalog / exports; officials cannot list players",
            "export_audit": "POST/GET /api/export-audit + server CSV log_export (H4.1)",
            "access_audit": "player 360 logs access_audit; GET /api/access-audit (D19)",
            "retention": "GET /api/retention/policy + POST /api/retention/sweep",
            "erasure": "DELETE /api/players/{id} nulls player_history PII (H3.2)",
            "boot_guard": "ENV=prod refuses default DB creds, weak TLS, dev Fernet key",
            "key_rotation": "PII_ENCRYPTION_KEYS MultiFernet + reencrypt_pii.py (H2.3)",
        },
        "release_gates_before_real_under13": [
            "ENV=prod with non-default DB role/password + TLS",
            "Real PII_ENCRYPTION_KEY(S) (not the POC dev key)",
            "ALLOW_UNDER13_PII=1 only after accepting residual plaintext",
            "Change default admin password",
            "Disk encryption on DB host + secret manager for keys",
            "Retention sweep scheduled (EMAIL_RETENTION_DAYS)",
        ],
    }
