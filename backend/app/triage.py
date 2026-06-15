"""Local, rule-based email triage (agent v0).

Suggests a classification for an inbound email from keyword rules — **entirely
local, no data leaves the building**, so it respects the minors'-PII constraint
(D5/§5.1) without an LLM. A human still confirms/overrides every suggestion.

Upgrade path (the still-open D5 call): swap `classify()` for an LLM that proposes
the classification + extracted fields. That sends email content to a model, so it
needs an explicit cloud-vs-local decision first.
"""
import re

from .email_extract import extract_doubles_pair, extract_name_usta_pairs

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


# "doubles" is a TOPIC word — a thread subject can say "L3 Macon - Doubles"
# while the body is just an acknowledgement ("No worries thank you") with no
# actual pairing request. Such emails should read as UNKNOWN (other), not a
# confident doubles. So a doubles label needs a CONCRETE pairing signal: a named
# pair, a "doubles partner(s)" phrase, a "pair/play doubles with <Name>" request,
# two surnames slashed in the subject, or an "add … for doubles" ask.
_DC_NAME = r"[A-Z][a-z][\w'’.-]*"
_DOUBLES_CONCRETE = [
    re.compile(r"\bdoubles?\s+partners?\b|\brandom\s+pair", re.I),
    re.compile(r"(?i:\b(?:pair\w*|partner\w*|play\s+doubles))\b[^.?!\n]{0,25}"
               r"\b(?i:with|and|&|up|for)\b\s*" + _DC_NAME),
    re.compile(_DC_NAME + r"\s*[/&]\s*" + _DC_NAME),
    re.compile(r"(?i:\b(?:add|enter|sign\s*up|register|put)\b)[^.?!\n]{0,25}"
               r"\bfor\s+(?:the\s+)?doubles?\b"),
]


def _has_concrete_doubles(subject: str | None, body: str | None) -> bool:
    text = f"{subject or ''} {body or ''}"
    if any(p.search(text) for p in _DOUBLES_CONCRETE):
        return True
    return bool(extract_doubles_pair(subject, body)) or len(extract_name_usta_pairs(subject, body)) >= 2


def _kw_match(text: str, kw) -> bool:
    if isinstance(kw, tuple) and kw[0] == "re":
        return re.search(kw[1], text) is not None
    return kw in text


def classify(subject: str | None, body: str | None) -> str:
    label = _classify_raw(subject, body)
    # A doubles label needs a CONCRETE pairing signal — otherwise a thread whose
    # only doubles evidence is the topic word ("…L3 Macon - Doubles" with a body
    # that's just "No worries thank you") reads as UNKNOWN (other), regardless of
    # which pass suggested doubles.
    if label == "doubles" and not _has_concrete_doubles(subject, body):
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
