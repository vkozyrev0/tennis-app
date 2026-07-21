"""Player detection for inbox emails (C2 split from routers/emails.py).

Used by the emails router (single detect), emails_bulk (bulk detect), and
importer auto-detect after PDF/CSV stage. Helpers take a cursor + text and
return match dicts — no FastAPI surface.
"""
import re
import unicodedata

from .email_extract import (
    extract_doubles_pair,
    extract_name_usta_pairs,
    extract_names,
    usta_candidates,
)

_WITHDRAW_BODY_RE = re.compile(
    r"([A-Z][\w'.\-]+(?:\s+[A-Z][\w'.\-]+)+)\s+has\s+requested\s+to\s+be\s+withdrawn", re.I)
# USTA portal withdrawal subject: "WITHDRAWAL REQUEST: <First>, Boys'/Girls' <N> & under …"
_USTA_SUBJECT_RE = re.compile(
    r"withdrawal\s+request\s*[:\-]\s*([A-Za-z][\w'\-]+)\s*,\s*(boys|girls)\b[^\d]*?(\d+)", re.I)


# Common letters that NFKD leaves intact (no base+combining decomposition).
_TRANSLIT = str.maketrans({
    "ø": "o", "œ": "oe", "æ": "ae", "ł": "l", "đ": "d", "ð": "d",
    "þ": "th", "ß": "ss", "ı": "i", "ŋ": "n", "ħ": "h", "ĸ": "k",
})


def _norm_name(s: str) -> str:
    """Fold a name to a comparable form: strip accents/diacritics, drop
    apostrophes ("O'Brien" == "OBrien"), lowercase, and reduce any other
    punctuation/whitespace run to single spaces. 'Renée O'Brien' and
    'Renee OBrien' both fold to 'renee obrien'."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    # Letters that DON'T NFKD-decompose to base+combining (Nordic/Polish/Turkish/
    # …) would otherwise be dropped by the a-z filter below and shatter the token
    # — fold them to their plain-ASCII base so "Sørensen" == "Sorensen".
    s = s.lower().translate(_TRANSLIT).replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _fuzzy_name_match(roster: list, name: str, exclude_ids: frozenset = frozenset()):
    """Resolve a parsed name STRING to a UNIQUE roster player by normalized,
    order-independent token matching — so 'Quintero, Maya', 'Maya R. Quintero',
    'Renée O'Brien' (vs 'Renee OBrien'), and a multi-word surname ('Van Der
    Berg') all land on the same player. Two passes, each requiring a single hit
    (ambiguous → None, never guess):

      1. every token of the roster first AND last name appears among the parsed
         tokens (subset match — tolerant of a middle name/initial in between)
      2. the full last name is present and the first *initial* matches (handles
         'K. Hampton' vs a roster 'Katherine Hampton')
    """
    toks = set(_norm_name(name).split())
    if len(toks) < 2:
        return None

    def _candidates(initial_only: bool):
        out = []
        for r in roster:
            if r["id"] in exclude_ids:
                continue
            ftoks = set(_norm_name(r["first_name"] or "").split())
            ltoks = set(_norm_name(r["last_name"] or "").split())
            if not ftoks or not ltoks or not ltoks <= toks:
                continue  # the whole surname must be present
            if ftoks <= toks:
                out.append(r)
            elif initial_only:
                # the ACTUAL first initial (first char of the given name) — not
                # the alphabetically-first token, which mis-folds "Mary Beth".
                fi = _norm_name(r["first_name"] or "")[:1]
                if fi and any(t[:1] == fi for t in (toks - ltoks)):
                    out.append(r)
        return out

    exact = _candidates(initial_only=False)
    if len(exact) == 1:
        return exact[0]
    if not exact:
        loose = _candidates(initial_only=True)
        if len(loose) == 1:
            return loose[0]
    return None


def _detect_player_for(cur, tournament_id: int, subject: str, body: str,
                       from_address: str = "", exclude_ids: frozenset = frozenset()) -> dict:
    """Best-effort "which player is this email about" detector.

    Layered from most to least reliable; the FIRST layer that yields an
    unambiguous roster hit wins, so high-precision signals (an explicit USTA #,
    a full name in the subject, the USTA portal withdrawal template) always beat
    weaker ones (a bare surname). Each layer is deliberately conservative — when
    a signal is ambiguous (e.g. two roster players share a surname) it is
    skipped rather than guessed, so a wrong tag is rarer than no tag.

    `match_kind` is returned for the UI so the TD can see *why* a player was
    picked (and trust a "usta" hit more than a "lastname" guess).
    """
    subject = subject or ""
    body = body or ""
    from_address = from_address or ""
    subj_low = subject.lower()
    text = f"{subject}\n{body}\n{from_address}"
    text_low = text.lower()

    cur.execute(
        "SELECT p.id, p.usta_number, p.first_name, p.last_name, p.gender, "
        "       e.age_division, "
        "       TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) AS name "
        "FROM player p JOIN tournament_entry e ON e.player_id = p.id "
        "WHERE e.tournament_id = %s",
        (tournament_id,),
    )
    roster = [r for r in cur.fetchall() if r["id"] not in exclude_ids]

    def ret(r, kind):
        return {"detected_player_id": r["id"], "detected_usta": r["usta_number"],
                "detected_player_name": r["name"], "match_kind": kind}

    def fullname_in(hay_low, r):
        f = (r["first_name"] or "").strip().lower()
        l = (r["last_name"] or "").strip().lower()
        if not f or not l:
            return False
        return f"{f} {l}" in hay_low or f"{l}, {f}" in hay_low

    # L1 — explicit USTA # anywhere in the email matched to a roster player.
    # Candidates (labeled / number-before-name / bare runs) come back in ORDER
    # OF APPEARANCE — for doubles the email lists the requester FIRST, so the
    # first matching number decides the primary (not roster iteration order).
    ustas = usta_candidates(subject, f"{body}\n{from_address}")
    if ustas:
        by_usta = {r["usta_number"]: r for r in roster if r["usta_number"]}
        for num in ustas:
            if num in by_usta:
                return ret(by_usta[num], "usta")

    # L2 — full name in the SUBJECT (subjects are deliberate → high precision).
    for r in roster:
        if fullname_in(subj_low, r):
            return ret(r, "fullname_subject")

    # L3 — USTA portal body template "<Full Name> has requested to be withdrawn".
    m = _WITHDRAW_BODY_RE.search(body)
    if m:
        cand = " ".join(m.group(1).split()).lower()
        for r in roster:
            if r["name"].lower() == cand:
                return ret(r, "withdraw_template")

    # L4 — full name anywhere in the body.
    for r in roster:
        if fullname_in(text_low, r):
            return ret(r, "fullname_body")

    # L5 — USTA portal subject template (first name + gender + age division).
    # Catches "WITHDRAWAL REQUEST: Siddhanth, Boys' 14 & under singles" where the
    # body lacks the surname: match first name within the right gender+division,
    # and only commit if exactly one roster player fits.
    sm = _USTA_SUBJECT_RE.search(subject)
    if sm:
        fn, gender_word, age = sm.group(1).lower(), sm.group(2).lower(), sm.group(3)
        want_gender = "male" if gender_word == "boys" else "female"
        cands = [r for r in roster
                 if (r["first_name"] or "").strip().lower() == fn
                 and (r["gender"] or "").lower() == want_gender
                 and age in (r["age_division"] or "")]
        if len(cands) == 1:
            return ret(cands[0], "usta_subject")

    # L6 — unique surname in the SUBJECT.
    subj_last = [r for r in roster if r["last_name"] and _surname_present(r["last_name"], subject)]
    if len(subj_last) == 1:
        return ret(subj_last[0], "lastname_subject")

    # L7 — unique surname anywhere (subject + body + sender). Last resort; only
    # fires when exactly one roster surname appears, so club/parent senders that
    # share a player's surname resolve to that lone player.
    text_last = [r for r in roster if r["last_name"] and _surname_present(r["last_name"], text)]
    if len(text_last) == 1:
        return ret(text_last[0], "lastname")

    # L8 — fuzzy full-name match (normalized, order-independent) over every
    # person-name span the text mentions. Catches what the exact-substring
    # layers above miss: "Quintero, Maya" inversion, a middle name/initial
    # ("Maya R. Quintero"), accents ("Renée O'Brien"), or odd spacing — the
    # common reasons a doubles PARTNER goes unmatched. Names parsed alongside a
    # USTA # (extract_name_usta_pairs) are included too. Order of appearance, so
    # the requester (named first) still wins the primary slot; unique hit only.
    seen_norm = set()
    # The two names joined by a pairing connector are the most likely players —
    # try them first, then any other name span, then names beside a USTA #.
    name_cands = list(extract_doubles_pair(subject, body))
    name_cands += list(extract_names(subject, body))
    name_cands += [p["name"] for p in extract_name_usta_pairs(subject, body)]
    for nm in name_cands:
        key = _norm_name(nm)
        if key in seen_norm:
            continue
        seen_norm.add(key)
        r = _fuzzy_name_match(roster, nm)
        if r:
            return ret(r, "fuzzy_name")

    # L9 — OFF-ROSTER USTA match: the email's USTA # belongs to a player who
    # exists in the system but isn't entered in THIS tournament (so L1 missed
    # them). USTA #s are unique → high confidence; we never off-roster-match on a
    # bare name (too many collisions system-wide). The distinct `usta_offroster`
    # kind lets the UI flag it and offer "add to roster". Reaching here means no
    # roster player carried any of these USTA #s.
    if ustas:
        cur.execute(
            "SELECT id, usta_number, "
            "TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name "
            "FROM player WHERE usta_number = ANY(%s)",
            (ustas,),
        )
        offs = [r for r in cur.fetchall() if r["id"] not in exclude_ids]
        if len(offs) == 1:
            r = offs[0]
            return {"detected_player_id": r["id"], "detected_usta": r["usta_number"],
                    "detected_player_name": r["name"], "match_kind": "usta_offroster"}

    return {"detected_player_id": None, "detected_usta": None,
            "detected_player_name": None, "match_kind": None}


def _surname_present(surname: str, text: str) -> bool:
    """Whether `surname` appears in `text` as a SURNAME — used by the last-resort
    unique-surname layers (L6/L7). Rejects the one false-positive shape the real
    corpus produced: a signature where the roster surname is actually someone
    else's FIRST name followed by a middle initial — "Alexander R. Jordan" must
    not match the roster player whose surname is 'Alexander'. So an occurrence
    immediately followed by a middle initial ("<word> R.") doesn't count; the
    surname qualifies only if it appears at least once NOT in that position.
    Plain "Smith Withdrawal" or "<First> Alexander" still qualify."""
    for m in re.finditer(rf"\b{re.escape(surname)}\b", text, re.IGNORECASE):
        if not re.match(r"\s+[A-Z]\.", text[m.end():m.end() + 6]):
            return True
    return False


def _unique_firstname_match(cur, tournament_id, subject, body, exclude_ids):
    """Last-resort partner finder: in a doubles email the partner is sometimes
    referenced by FIRST name only ("…I don't have Mia's parent confirmation yet
    to pair them"). Match a roster first name that appears in the text — but ONLY
    when exactly one roster player qualifies (never guess between two), and
    case-SENSITIVELY so a name that doubles as a common word ("Will", "Grace",
    "May") doesn't match its lowercase use. Doubles-partner scoped (the caller
    only invokes it for that), so the precision bar can be lower than the general
    detector."""
    text = f"{subject or ''}\n{body or ''}"
    cur.execute(
        "SELECT p.id, p.usta_number, p.first_name, "
        "       TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) AS name "
        "FROM player p JOIN tournament_entry e ON e.player_id = p.id "
        "WHERE e.tournament_id = %s",
        (tournament_id,),
    )
    hits = [r for r in cur.fetchall()
            if r["id"] not in exclude_ids and r["first_name"]
            and re.search(rf"\b{re.escape(r['first_name'])}\b", text)]
    ids = {r["id"] for r in hits}
    return hits[0] if len(ids) == 1 else None


def _detect_pair_for(cur, tournament_id, subject, body, from_address, classification):
    """Multi-player detection for the classifications that name several players.

    - doubles: requester + ONE partner -> second pass with the primary excluded.
    - pairing_avoidance: a GROUP ("don't pair A with B and C") -> keep re-running
      the layered match, excluding everyone found so far, until it comes up dry
      (capped at 6 - beyond that it's matching noise, not a group).
    Other classifications keep both slots NULL."""
    d = _detect_player_for(cur, tournament_id, subject, body, from_address)
    partner = {"detected_partner_id": None, "detected_partner_name": None,
               "detected_partner_usta": None, "partner_match_kind": None}
    member_ids = None
    if classification == "doubles" and d["detected_player_id"]:
        p = _detect_player_for(cur, tournament_id, subject, body, from_address,
                               exclude_ids=frozenset({d["detected_player_id"]}))
        if p["detected_player_id"]:
            partner = {"detected_partner_id": p["detected_player_id"],
                       "detected_partner_name": p["detected_player_name"],
                       "detected_partner_usta": p["detected_usta"],
                       "partner_match_kind": p["match_kind"]}
        else:
            # The layered detector found no second full name / USTA #. Fall back
            # to a UNIQUE roster first name in the text — the partner is often
            # named only by first name ("…to pair them with Mia").
            fp = _unique_firstname_match(
                cur, tournament_id, subject, body, frozenset({d["detected_player_id"]}))
            if fp:
                partner = {"detected_partner_id": fp["id"], "detected_partner_name": fp["name"],
                           "detected_partner_usta": fp["usta_number"],
                           "partner_match_kind": "firstname"}
    elif classification == "pairing_avoidance" and d["detected_player_id"]:
        found = [d["detected_player_id"]]
        while len(found) < 6:
            nxt = _detect_player_for(cur, tournament_id, subject, body, from_address,
                                     exclude_ids=frozenset(found))
            if not nxt["detected_player_id"]:
                break
            found.append(nxt["detected_player_id"])
        if len(found) >= 2:          # one name isn't a group - leave NULL
            member_ids = found
    return d, partner, member_ids

