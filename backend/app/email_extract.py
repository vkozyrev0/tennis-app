"""Pure regex extractors over email text — no DB, no HTTP (plan P2 #9).

Extracted from routers/emails.py so the parsing rules are unit-testable
directly. Everything here takes (subject, body) strings and returns a small
value or None — "surface what's clearly stated, leave the rest for the TD".
The DB-coupled player DETECTOR (_detect_player_for) stays in the router.
"""
import re

_USTA_RE = re.compile(r"\b(\d{9,11})\b")
# A name token: 2–3 of these make a name. (?!USTA\b) keeps the label itself from
# being eaten as a name token; hyphens only join letter groups so a dangling
# "Hello-" doesn't qualify. `\w` is Unicode by default → accented letters keep.
_NAME_TOKEN = (r"(?:(?!USTA\b)[A-Z][\w'’.]*(?:-[A-Z][\w'’.]*)*"
               r'|["“][A-Z]' + r"[\w'’.]*" + r'["”])')
_NAME_GRP = r"(" + _NAME_TOKEN + r"(?:\s+" + _NAME_TOKEN + r"){1,2})"
# The "symbols to skip" between a name and its USTA # — whitespace (incl. a line
# break), and the punctuation a roster/PDF puts between fields: dashes, colons,
# semicolons, commas, dots, #, *, |, /, underscores, parentheses, brackets. NO
# letters (beyond the optional USTA label below) ride in the gap, so a number
# never binds to a name on the far side of other words. Bounded length → linear,
# no pathological backtracking. This is the heart of the doubles fix: real PDFs
# separate name and number with all sorts of glue ("Kate Hampton -- USTA#:  …",
# "Kate Hampton\n2018840232", "(2018840232) Kate Hampton").
_SKIP = r"[ \t\-–—_:;,.#*|/()\[\]\r\n]{0,18}"
_USTA_LBL = (r"(?i:usta\s*(?:member(?:ship)?\s*)?(?:#|no\.?|number|id)?\s*"
             r"(?:is\s*)?[:#]?\s*)?")
# <number> <skip/label> <name>  — "21043871 Ethan Carter", "(2018840232) Kai Hosch"
_USTA_NAME_RE = re.compile(r"\b(\d{8,11})\b" + _SKIP + _USTA_LBL + _NAME_GRP)
# <name> <skip/label> <number>  — "Kate Hampton USTA# 2018840232",
# "Alexandra Dimitrov (USTA 2018522196)", "Ava Wright — 2018460819"
_NAME_USTA_AFTER_RE = re.compile(
    _NAME_GRP + r"(?:'s|’s)?" + _SKIP + _USTA_LBL + r"#?\s*(\d{8,11})\b")
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


def usta_candidates(subject: str | None, body: str | None) -> list[str]:
    """Plausible USTA #s in ORDER OF APPEARANCE (the email's order is the
    players' order — for doubles the requester usually comes first). A number
    qualifies if it is (a) labeled ("USTA # 21043871", 8–11 digits),
    (b) adjacent to a capitalized name in EITHER direction ("21043871 Ethan
    Carter" / "Kate Hampton USTA# 2018840232"), or (c) a bare 9–11 digit run.
    Phone numbers usually survive as formatted strings (dots/dashes), so bare
    runs are a fair signal; bare EIGHT-digit runs only count with an adjacent
    name."""
    text = f"{subject or ''}\n{body or ''}"
    hits: list[tuple[int, str]] = []
    for rx in (_USTA_LABELED_RE, _USTA_NAME_RE, _USTA_RE):
        for m in rx.finditer(text):
            hits.append((m.start(1), m.group(1)))
    for m in _NAME_USTA_AFTER_RE.finditer(text):      # name-first adjacency
        hits.append((m.start(2), m.group(2)))
    out: list[str] = []
    for _pos, n in sorted(hits):
        if n not in out:
            out.append(n)
    return out


def extract_name_usta_pairs(subject: str | None, body: str | None,
                            limit: int = 4) -> list[dict]:
    """Ordered (name, usta) PAIRS parsed from the text — both directions
    ("Kate Hampton USTA# 2018840232" and "2018840232 Kate Hampton"). This is
    what the inbox shows for a doubles email whose players aren't (yet) on
    the roster: the email itself says who the numbers belong to. Deduped by
    number, first mention wins."""
    text = f"{subject or ''}\n{body or ''}"
    hits: list[tuple[int, str, str]] = []
    for m in _NAME_USTA_AFTER_RE.finditer(text):
        hits.append((m.start(1), m.group(1), m.group(2)))
    for m in _USTA_NAME_RE.finditer(text):
        hits.append((m.start(1), m.group(2), m.group(1)))
    out: list[dict] = []
    seen: set[str] = set()
    for _pos, name, num in sorted(hits):
        if num in seen:
            continue
        cleaned = _clean_name(name)
        if not cleaned:
            continue
        seen.add(num)
        out.append({"name": cleaned, "usta": num})
    return out[:limit]


_NAME_STOPWORDS = {"His", "Her", "Their", "The", "He", "She", "Hello", "Hi",
                   # connector / glue words that ride between two partner names
                   # ("Kate Hampton And Mia Lopez") — trimmed so each side cleans
                   # to a real 2-token name.
                   "And", "Or", "With", "Amp", "Partner", "Partnering",
                   "Please", "Thanks", "Thank", "Regards", "Best", "From"}

# A plausible person-name span: 2–3 capitalized tokens, independent of any USTA
# number — so a doubles email that merely *names* both players ("Kate Hampton
# and Mia Lopez", "partnering with Mia Lopez") still surfaces who to match.
# `\w` is Unicode by default for str patterns in Python 3, so accented letters
# inside a token are kept. The negative lookahead keeps glue words (USTA, And,
# With, …) from being swallowed as a name token mid-run.
# Words that are capitalized in these emails but are never part of a player's
# name — glue between two partners, or a sentence/subject lead-in. Excluded from
# name tokens so a span starts at the real name ("Pairing Kate Hampton" → the
# span is just "Kate Hampton").
_NAME_GLUE = (r"(?:USTA|And|Or|With|The|Please|Thanks|Thank|Regards|Best|From|"
              r"Partner|Partnering|Pairing|Pair|Doubles|Singles|Mixed|Request|"
              r"Requesting|Dear|Subject|Hello|Hi|Hey|Team|Good|Morning|"
              r"Afternoon|Evening|Re|Fwd|Fw)\b")
_PERSON_TOKEN = r"(?:(?!" + _NAME_GLUE + r")[A-Z][\w'’.]*(?:-[A-Z][\w'’.]*)*)"
_PERSON_NAME_RE = re.compile(_PERSON_TOKEN + r"(?:\s+" + _PERSON_TOKEN + r"){1,2}")


def extract_names(subject: str | None, body: str | None, limit: int = 8) -> list[str]:
    """Ordered person-name spans (2–3 capitalized tokens) parsed from the text,
    regardless of any USTA #. This is the name-only signal the doubles detector
    falls back to when a partner is named but carries no number — e.g.
    "Maya Quintero would like to partner with Zara Hollis". Cleaned + de-duped
    (case-insensitive), first mention wins."""
    text = f"{subject or ''}\n{body or ''}"
    out: list[str] = []
    seen: set[str] = set()
    for m in _PERSON_NAME_RE.finditer(text):
        cleaned = _clean_name(m.group(0))
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= limit:
            break
    return out


def _clean_name(raw: str) -> str | None:
    """Trim sentence leakage off a captured name: a leading token that ends a
    previous sentence ("Macon. Ava Wright"), a trailing pronoun ("… Bondo. His"),
    or a trailing possessive ("Declan Finley. Declan's"). Needs 2+ tokens left."""
    tokens = raw.replace('"', " ").replace("“", " ").replace("”", " ").split()
    while tokens and (tokens[0].endswith(".") or tokens[0] in _NAME_STOPWORDS):
        tokens.pop(0)
    while tokens and (tokens[-1] in _NAME_STOPWORDS
                      or tokens[-1].endswith(("'s", "’s"))):
        tokens.pop()
    tokens = [t.rstrip(".") for t in tokens]
    return " ".join(tokens) if len(tokens) >= 2 else None


# Two player names joined by a pairing connector — the doubles shape that
# carries NO USTA # at all ("Mia Langone and Chelsea Ie", "pair Ankush Kotti
# with Watts Goodman"). Connectors: and / with / plus / & / + / / / comma. A
# hyphen is deliberately NOT a connector (it sits in sign-offs like
# "Leilei - Mia's mom"). Glue words can't be a name token (see _PERSON_TOKEN),
# so the two captured groups are clean name spans.
_PERSON_NAME = _PERSON_TOKEN + r"(?:\s+" + _PERSON_TOKEN + r"){1,2}"
_PAIR_CONNECTOR = r"\s*(?:&|\+|/|,|\band\b|\bwith\b|\bplus\b)\s*"
_DOUBLES_PAIR_RE = re.compile("(" + _PERSON_NAME + ")" + _PAIR_CONNECTOR
                              + "(" + _PERSON_NAME + ")")


def extract_doubles_pair(subject: str | None, body: str | None) -> list[str]:
    """The TWO player names in a doubles request that names them but gives no
    USTA # — found by the pairing connector between two name spans. Returns
    [name1, name2] (requester first, as written) or [] when no connected pair is
    present. This is what lets a name-only doubles email still surface BOTH
    players for the TD to confirm / add to the roster."""
    text = f"{subject or ''}\n{body or ''}"
    m = _DOUBLES_PAIR_RE.search(text)
    if not m:
        return []
    out: list[str] = []
    for g in (m.group(1), m.group(2)):
        nm = _clean_name(g)
        if nm and nm not in out:
            out.append(nm)
    return out


def extract_ustas(subject: str | None, body: str | None, limit: int = 3) -> list[str]:
    """ALL plausible USTA #s for the multi-player classifications (doubles /
    pairing avoidance) — emails may carry a number for one player, both, or
    neither. Position-ordered (see usta_candidates), deduped, capped at
    `limit` (a wall of digits is noise, not a roster)."""
    return usta_candidates(subject, body)[:limit]


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
