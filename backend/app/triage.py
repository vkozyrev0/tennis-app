"""Local, rule-based email triage (agent v0).

Suggests a classification for an inbound email from keyword rules — **entirely
local, no data leaves the building**, so it respects the minors'-PII constraint
(D5/§5.1) without an LLM. A human still confirms/overrides every suggestion.

Upgrade path (the still-open D5 call): swap `classify()` for an LLM that proposes
the classification + extracted fields. That sends email content to a model, so it
needs an explicit cloud-vs-local decision first.
"""

# Order matters: more specific intents first.
_RULES = [
    ("withdrawal", ["withdraw", "withdrawn", "withdrawing", "pull out", "pulling out", "drop out", "dropping out"]),
    ("late_entry", ["late entry", "late entrant", "late add", "register late", "missed the deadline", "still enter", "still register"]),
    ("doubles", ["doubles", "partner", "random pair", "random pairing", "pair me", "pair us"]),
    ("pairing_avoidance", ["same club", "sibling", "siblings", "not play each other", "don't draw", "do not draw", "avoid drawing", "first round"]),
    ("scheduling_avoidance", ["can't play", "cannot play", "not available", "unavailable", "time conflict", "avoid the", "before 10", "after ", "day/time"]),
    ("division_flex", ["division", "play up", "move up", "willing to play", "other division", "fill the draw"]),
    ("hotel", ["hotel", "staying at", "lodging", "room block", "marriott", "hyatt", "hilton", "inn "]),
]


def classify(subject: str | None, body: str | None) -> str:
    text = f"{subject or ''} {body or ''}".lower()
    for label, keywords in _RULES:
        if any(k in text for k in keywords):
            return label
    return "other"
