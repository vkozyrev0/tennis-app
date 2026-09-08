"""Local, rule-based email triage (agent v0).

Suggests a classification for an inbound email from keyword rules — **entirely
local, no data leaves the building**, so it respects the minors'-PII constraint
(D5/§5.1) without an LLM. A human still confirms/overrides every suggestion.

Upgrade path (the still-open D5 call): swap `classify()` for an LLM that proposes
the classification + extracted fields. That sends email content to a model, so it
needs an explicit cloud-vs-local decision first.
"""
import re
import time

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
                 r"\brandom\s+pair", r"\bpair\b[^.?!\n]{0,30}\b(?:and|with|&)\b[^.?!\n]{0,30}\bdoubles?\b",
                 r"\bconfirm(?:ed|ing)?\s+(?:partnership|doubles|partner|pairing)\b",
                 r"\bdoubles?\s+confirmation\b",
                 r"\b(?:new|change(?:d)?|switch(?:ed)?)\s+partners?\b",
                 r"\b(?:doubles?\s+)?pairing[- ]change\b",
                 r"\breplac(?:e|ing|ed)\s+(?:my\s+)?partners?\b",
                 r"\bpair(?:ed|ing)?\s+up\s+with\b",
                 r"\bplay(?:s|ing)?\s+doubles\b",
                 r"\bcan\s+(?:be\s+)?pair(?:ed)?\s+with\b",
                 r"\bplay\s+doubles\s+with\b"]),
    ("late_entry", [r"\blate\s+(?:entry|entrant|add)\b", r"\bmissed\s+the\s+deadline\b",
                    r"\b(?:still|can\s+\w+)\s+(?:enter|register)\b",
                    r"\badd\b[\s\S]{0,40}\bfor\s+singles\b",
                    r"\benter\b[\s\S]{0,40}\bsingles\b",
                    r"\bplay(?:ing)?\s+(?:in\s+)?(?:\w+\s+)?singles\b",
                    r"\bconfirm(?:ed|ing)?\s+[\s\S]{0,40}\bfor\s+singles\b",
                    r"\bsingles?\s+confirmation\b",
                    r"\bwould\s+like\s+to\s+(?:play|enter|be\s+in)\s+[\s\S]{0,40}\bsingles\b",
                    r"\bsingles?\s+partners?\b",
                    r"\bwould\s+like\s+to\s+be\s+singles\s+partners?\b",
                    r"\bpair(?:\s+up|\s+together)?\b[\s\S]{0,80}\bsingles\b",
                    r"\bwill\s+partner\s+in[\s\S]{0,40}\bsingles\b"]),
]
_STRONG_RE = [(label, [re.compile(p, re.I) for p in pats]) for label, pats in _STRONG]
_DOUBLES_KEEP_ONE = [
    re.compile(p, re.I) for p in (
        r"\bconfirm(?:ed|ing)?\s+(?:partnership|doubles|partner|pairing)\b",
        r"\bdoubles?\s+confirmation\b",
        r"\b(?:new|change(?:d)?|switch(?:ed)?)\s+partners?\b",
        r"\b(?:doubles?\s+)?pairing[- ]change\b",
        r"\breplac(?:e|ing|ed)\s+(?:my\s+)?partners?\b",
        r"\badd\b.{0,40}\bfor\s+doubles\b",
        r"\benter\b.{0,40}\bdoubles\b",
        r"\bfind\s+a\s+partner\b",
        r"\bpair(?:ed|ing)?\s+up\s+with\b",
        r"\bplay(?:s|ing)?\s+doubles\b",
        r"\bplay\s+doubles\s+with\b",
        # Event-title subjects (Boys 14 Doubles / Southerns Boys 14 Doubles)
        # are doubles even with no extracted pair — not generic "… Doubles" acks.
        r"\b(?:boys?|girls?)\s*\d{1,2}(?:s|'s)?\s+doubles?\b",
        r"\b[bg]\s*-?\s*\d{1,2}s?\s+doubles?\b",
    )
]


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
_SINGLES_WORD_RE = re.compile(r"\bsingles?\b", re.I)
_DOUBLES_WORD_RE = re.compile(r"\bdoubles?\b", re.I)
# Third-party rumor: someone else's partner is withdrawing — not a WD request.
_PARTNER_WD_RUMOR_RE = re.compile(
    r"\b(?:his|her|their)\s+(?:double\s+)?partners?\b.{0,90}\b"
    r"(?:withdraw|withdrawing|withdrawn|going\s+to\s+withdraw)\b"
    r"|\b(?:[A-Za-z][\w'’.-]*)['’]s\s+partners?\s+is\s+withdrawing\b",
    re.I | re.S,
)
_DOUBLES_REQUEST_RE = re.compile(
    r"\b(?:pair(?:ed|ing)?\s+up|play(?:s|ing)?\s+doubles|pair\s+with|"
    r"play\s+doubles\s+with|can\s+(?:be\s+)?pair(?:ed)?\s+with|"
    r"doubles?\s+partners?)\b",
    re.I,
)


def _singles_only(text: str) -> bool:
    """True when the email is about singles and never mentions doubles."""
    return bool(_SINGLES_WORD_RE.search(text)) and not _DOUBLES_WORD_RE.search(text)


def classify(subject: str | None, body: str | None) -> str:
    label = _classify_raw(subject, body)
    text = f"{subject or ''} {body or ''}"
    # Require the right number of identifiable PLAYERS, else fall back to UNKNOWN
    # (other): a doubles label needs two named players, a withdrawal needs one.
    # Exception: an explicit RANDOM-pairing request names no partner by design.
    # Strong pairing-change / confirmation phrases keep `doubles` even with one
    # named player — those are the emails that used to land as Other.
    if label == "doubles":
        # Pairing / partner language on a singles-only email is a singles entry,
        # not a doubles request (the doubles→singles fixture copies).
        if _singles_only(text):
            label = "late_entry"
        else:
            # Pairing-change / confirmation phrases keep doubles even with one name.
            # Other STRONG doubles hits (e.g. "pair them") still need two players.
            keep_one = any(p.search(text) for p in _DOUBLES_KEEP_ONE)
            if (_doubles_name_count(subject, body) < 2
                    and not _RANDOM_PAIR_RE.search(text)
                    and not keep_one):
                label = "other"
    if label == "withdrawal" and not extract_withdraw_name(subject, body):
        # Portal subject "Withdrawal Request" is enough to keep the label even
        # when the quoted original (with the name) was stripped.
        if not re.search(r"withdrawal\s+request", subject or "", re.I):
            label = "other"
    if label != "other":
        return label
    # Optional local tiny-LLM second pass for leftovers only (EMAIL_LLM=1).
    from .email_llm import maybe_intent
    return maybe_intent(subject, body, label)


def classify_timed(subject: str | None, body: str | None) -> tuple[str, int]:
    """Run ``classify`` and return ``(label, elapsed_ms)`` for the inbox stamp."""
    t0 = time.perf_counter()
    label = classify(subject, body)
    ms = int((time.perf_counter() - t0) * 1000)
    return label, ms


def _classify_raw(subject: str | None, body: str | None) -> str:
    subj = (subject or "").lower()
    text = f"{subj} {(body or '').lower()}"
    singles_only = _singles_only(text)
    # 1) Strongest, unambiguous phrases first — resolves competing signals.
    for label, pats in _STRONG_RE:
        if label == "doubles" and singles_only:
            continue
        if any(p.search(text) for p in pats):
            # Partner-is-withdrawing rumor + a pairing request is doubles, not WD.
            if (label == "withdrawal" and _PARTNER_WD_RUMOR_RE.search(text)
                    and _DOUBLES_REQUEST_RE.search(text)):
                continue
            return label
    # 2) The SUBJECT is the deliberate intent line; trust a keyword there over an
    #    incidental mention in the quoted body ("Macon L3 Doubles" → doubles).
    for label, keywords in _RULES:
        if label == "doubles" and singles_only:
            continue
        if any(_kw_match(subj, k) for k in keywords):
            return label
    # 3) Fall back to broad keywords over the whole text.
    for label, keywords in _RULES:
        if label == "doubles" and singles_only:
            continue
        if any(_kw_match(text, k) for k in keywords):
            return label
    return "other"
