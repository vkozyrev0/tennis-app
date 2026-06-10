"""Pure regex extractors over email text — no DB, no HTTP (plan P2 #9).

Extracted from routers/emails.py so the parsing rules are unit-testable
directly. Everything here takes (subject, body) strings and returns a small
value or None — "surface what's clearly stated, leave the rest for the TD".
The DB-coupled player DETECTOR (_detect_player_for) stays in the router.
"""
import re

_USTA_RE = re.compile(r"\b(\d{9,11})\b")
# A USTA # explicitly labeled in the text ("USTA #: 1234567890", "membership
# number 1234567890"). Higher confidence than a bare run of digits, so it wins.
_USTA_LABELED_RE = re.compile(
    r"(?:usta|membership)\s*(?:member(?:ship)?\s*)?(?:#|no\.?|number|id)?\s*[:#]?\s*(\d{8,11})",
    re.I,
)


def extract_usta(subject: str | None, body: str | None) -> str | None:
    """Pull the player's USTA # out of an email when present, independent of any
    roster match (so a PDF-imported email shows its USTA # even before — or
    without — a player is matched). Prefers an explicitly *labeled* number; falls
    back to a lone bare 9–11 digit run, and gives up if several bare numbers
    appear (ambiguous — could be a phone, a confirmation #, etc.)."""
    text = f"{subject or ''}\n{body or ''}"
    m = _USTA_LABELED_RE.search(text)
    if m:
        return m.group(1)
    nums = set(_USTA_RE.findall(text))
    return next(iter(nums)) if len(nums) == 1 else None


# Withdrawal-reason extraction, ranked most→least reliable based on the real
# email corpus:
#   1. explicit "Reason: <X>" field (forwarded forms: "Player Name… Reason: Injury
#      Round/Event:…") — but NOT the USTA portal's "for the following reason:"
#      boilerplate, which is followed by canned "Please go to…" text (no reason).
#   2. "due to <X>" free text ("…due to leg injury.").
#   3. keyword fallback → a normalized category (Injury / Illness).
# Returns a short string or None (None ⇒ TD fills it in by hand).
_REASON_FIELD_RE = re.compile(r"(?<!following )reason\s*[:\-]\s*(.+)", re.I)
_REASON_STOP_RE = re.compile(r"\b(?:round/event|event|round|player name|withdrawing)\s*[:\-]?", re.I)
_DUE_TO_RE = re.compile(r"\bdue to\s+(.+?)(?:[.;\n]|\bplease\b|\bthanks?\b|$)", re.I)


def extract_withdrawal_reason(subject: str, body: str):
    text = f"{subject or ''}\n{body or ''}"
    # 1) explicit "Reason: X" on a line (skip the portal boilerplate).
    for line in text.splitlines():
        m = _REASON_FIELD_RE.search(line)
        if not m:
            continue
        val = _REASON_STOP_RE.split(m.group(1).strip(), maxsplit=1)[0].strip(" .,;-")
        if val and not val.lower().startswith(("please", "the player")):
            return val[:80]
    # 2) "due to <reason>"
    m = _DUE_TO_RE.search(text)
    if m:
        val = m.group(1).strip(" .,;-")
        if val:
            return val[:80]
    # 3) keyword fallback → normalized category
    low = text.lower()
    if re.search(r"\b(injur(?:y|ed|ies)|hurt|broke|broken|sprain(?:ed)?|fracture)\b", low):
        return "Injury"
    if re.search(r"\b(sick|illness|ill|unwell|fever|covid|flu)\b", low):
        return "Illness"
    return None


# Junior age-division extraction → a canonical roster code (B/G + age), so the
# inbox can pre-fill the late-entry "Age division" picker. Two signals:
#   1. an explicit code already in the text ("B14", "G 16")
#   2. the USTA wording "Boys'/Girls' <age> [& under]"
# Only the junior ladder (10/12/14/16/18) is recognized — adult NTRP/Combo
# divisions aren't named in these parent emails, so we don't guess them.
_JUNIOR_AGES = {"10", "12", "14", "16", "18"}
_DIV_WORD_RE = re.compile(r"\b(boys|girls)['‘’ʼ]?\s*(10|12|14|16|18)\b", re.I)
_DIV_CODE_RE = re.compile(r"\b([BG])\s?-?\s?(10|12|14|16|18)\b")


def extract_age_division(subject: str, body: str):
    """Best-effort junior division code (e.g. 'B14') from the email, or None."""
    text = f"{subject or ''}\n{body or ''}"
    m = _DIV_WORD_RE.search(text)
    if m:
        return ("B" if m.group(1).lower() == "boys" else "G") + m.group(2)
    m = _DIV_CODE_RE.search(text)
    if m and m.group(2) in _JUNIOR_AGES:
        return m.group(1).upper() + m.group(2)
    return None


def extract_events(subject: str, body: str):
    """Comma-joined junior event names mentioned ('Singles, Doubles'), or None.
    Values match the event-catalog option values the late/withdrawal forms use,
    so the inbox can pre-select them. 'mixed [doubles]' → 'Mixed Doubles', and
    that phrase is stripped before the plain-doubles check so it isn't counted
    twice."""
    t = f"{subject or ''} {body or ''}".lower()
    out = []
    if re.search(r"\bsingles\b", t):
        out.append("Singles")
    if re.search(r"\bmixed\b", t):
        out.append("Mixed Doubles")
    if re.search(r"\bdoubles\b", re.sub(r"\bmixed\s+doubles\b", "", t)):
        out.append("Doubles")
    return ", ".join(out) or None


# Scheduling-avoidance day + time-range extraction → the two free-text fields the
# scheduling form asks for. Conservative: surface what's clearly stated, leave the
# rest for the TD.
_DAYS = [("monday", "Mon"), ("tuesday", "Tue"), ("wednesday", "Wed"),
         ("thursday", "Thu"), ("friday", "Fri"), ("saturday", "Sat"), ("sunday", "Sun")]
_TIME_RE = re.compile(
    r"\b(before|after|by|until|till)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?",
    re.I)
_DAYPART_RE = re.compile(r"\b(mornings?|afternoons?|evenings?|nights?|noon|midday)\b", re.I)


def extract_avoid_day(subject: str, body: str):
    """Weekday(s) mentioned, as abbreviations ('Sat' / 'Sat, Sun'), or None."""
    t = f"{subject or ''} {body or ''}".lower()
    found = [abbr for full, abbr in _DAYS
             if re.search(rf"\b({full}|{abbr.lower()})\b", t)]
    return ", ".join(found) or None


def extract_avoid_time(subject: str, body: str):
    """A short time-constraint string ('before 10 am', 'after 5 pm', 'mornings')
    or None. A before/after/until clause wins over a vaguer day-part word."""
    text = f"{subject or ''} {body or ''}"
    m = _TIME_RE.search(text)
    if m:
        prep, hour = m.group(1).lower(), m.group(2)
        mins = f":{m.group(3)}" if m.group(3) else ""
        mer = (m.group(4) or "").lower().replace(".", "")
        return f"{prep} {hour}{mins}{(' ' + mer) if mer else ''}"[:40]
    m = _DAYPART_RE.search(text)
    if m:
        return m.group(1).lower()
    return None
