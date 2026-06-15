"""Local, rule-based email triage (agent v0).

Suggests a classification for an inbound email from keyword rules — **entirely
local, no data leaves the building**, so it respects the minors'-PII constraint
(D5/§5.1) without an LLM. A human still confirms/overrides every suggestion.

Upgrade path (the still-open D5 call): swap `classify()` for an LLM that proposes
the classification + extracted fields. That sends email content to a model, so it
needs an explicit cloud-vs-local decision first.
"""
import re

from .email_extract import (
    extract_doubles_pair,
    extract_name_usta_pairs,
    extract_surname_pair,
    extract_withdraw_name,
)

# Order matters: more specific intents first. Each rule entry is either a
# bare keyword (substring match, lowercased) or a tuple ("re", pattern) for
# anchored / digit-bounded patterns (audit F12).
_RULES = [
    ("withdrawal", ["withdraw", "withdrawn", "withdrawing", "pull out", "pulling out", "drop out", "dropping out"]),
    ("late_entry", ["late entry", "late entrant", "late add", "register late", "missed the deadline", "still enter", "still register"]),
    ("doubles", ["doubles", "partner", "random pair", "random pairing", "pair me", "pair us"]),
    ("pairing_avoidance", ["same club", "sibling", "siblings", "not play each other", "don't draw", "do not draw", "avoid drawing", "first round"]),
    # Audit F12: "after " as a bare substring matched "after lunch" / "after
    # the holidays" etc. — tighten to require a time-of-day digit.
    ("scheduling_avoidance", ["can't play", "cannot play", "not available", "unavailable", "time conflict", "avoid the", ("re", r"\bbefore \d"), ("re", r"\bafter \d"), "day/time"]),
    ("division_flex", ["division", "play up", "move up", "willing to play", "other division", "fill the draw"]),
    ("hotel", ["hotel", "staying at", "lodging", "room block", "marriott", "hyatt", "hilton", "inn "]),
]


# High-confidence, UNAMBIGUOUS phrases — tried first, in priority order, so a
# clear intent wins over an incidental mention elsewhere in the (often quoted)
# thread. This is what stops "…please pair Zaria and Everly for doubles. Their
# old partner Zeal is withdrawing" from reading as a withdrawal: it has a strong
# doubles signal and no strong withdrawal one. Compiled patterns, matched
# against subject+body.
_STRONG = [
    ("withdrawal", [r"\bplease\s+withdraw\b", r"\brequest(?:ed|ing)?\s+to\s+be\s+withdrawn\b",
                    r"\bwill\s+be\s+unable\s+to\s+(?:participate|play|attend|compete)\b",
                    r"\b(?:would\s+like|want|wish|need|hoping|going)\s+to\s+withdraw\b",
                    r"\bwithdraw(?:ing|n|al)?\s+(?:him|her|them|my\s+\w+|\w+)?\s*from\s+the\s+(?:tournament|event|draw)\b"]),
    ("doubles", [r"\bdoubles?\s+partners?\b", r"\bwould\s+like\s+to\s+(?:pair|partner|be\s+(?:doubles\s+)?partners?)\b",
                 r"\bpair\s+(?:up|me|us|them)\b", r"\bpair\b[^.?!\n]{0,40}\bfor\s+(?:\w+\s+)?doubles?\b",
                 r"\brandom\s+pair", r"\bpair\b[^.?!\n]{0,30}\b(?:and|with|&)\b[^.?!\n]{0,30}\bdoubles?\b"]),
    ("late_entry", [r"\blate\s+(?:entry|entrant|add)\b", r"\bmissed\s+the\s+deadline\b",
                    r"\b(?:still|can\s+\w+)\s+(?:enter|register)\b"]),
]
_STRONG_RE = [(label, [re.compile(p) for p in pats]) for label, pats in _STRONG]


# A classification is only trustworthy when the right number of PLAYERS can
# actually be named: doubles needs TWO, a withdrawal needs ONE. Otherwise the
# email's only evidence is a topic word ("…L3 Macon - Doubles" over an
# acknowledgement body, "WITHDRAWAL REQUEST" with no name), and it should read as
# UNKNOWN (other) for a human to review rather than a confident classification.
# Two surnames slashed in the subject ("Pfifer / Mehendiratta") count as a pair
# — same extractor the inbox grid uses to SHOW them, so label and names agree.
def _doubles_name_count(subject: str | None, body: str | None) -> int:
    return max(len(extract_doubles_pair(subject, body)),
               len(extract_name_usta_pairs(subject, body)),
               len(extract_surname_pair(subject)))


def _kw_match(text: str, kw) -> bool:
    if isinstance(kw, tuple) and kw[0] == "re":
        return re.search(kw[1], text) is not None
    return kw in text


_RANDOM_PAIR_RE = re.compile(r"\brandom\s+pair", re.I)


def classify(subject: str | None, body: str | None) -> str:
    label = _classify_raw(subject, body)
    # Require the right number of identifiable PLAYERS, else fall back to UNKNOWN
    # (other): a doubles label needs two named players, a withdrawal needs one.
    # Exception: an explicit RANDOM-pairing request names no partner by design.
    if label == "doubles":
        if _doubles_name_count(subject, body) < 2 and not _RANDOM_PAIR_RE.search(f"{subject or ''} {body or ''}"):
            return "other"
    if label == "withdrawal" and not extract_withdraw_name(subject, body):
        return "other"
    return label


def _classify_raw(subject: str | None, body: str | None) -> str:
    subj = (subject or "").lower()
    text = f"{subj} {(body or '').lower()}"
    # 1) Strongest, unambiguous phrases first — resolves competing signals.
    for label, pats in _STRONG_RE:
        if any(p.search(text) for p in pats):
            return label
    # 2) The SUBJECT is the deliberate intent line; trust a keyword there over an
    #    incidental mention in the quoted body ("Macon L3 Doubles" → doubles).
    for label, keywords in _RULES:
        if any(_kw_match(subj, k) for k in keywords):
            return label
    # 3) Fall back to broad keywords over the whole text.
    for label, keywords in _RULES:
        if any(_kw_match(text, k) for k in keywords):
            return label
    return "other"
