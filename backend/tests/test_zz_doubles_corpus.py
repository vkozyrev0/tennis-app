"""Corpus smoke test: parse the REAL exported email PDF
(tests/fixtures/tournament_emails.pdf) and pin the parser → classifier →
doubles-pair extraction pipeline end to end. This is the regression net for the
doubles-detection work — if the PDF parsing, triage keywords, or the name/USTA
extractors drift, the counts here move. Pure functions only (no DB/HTTP)."""
from pathlib import Path

from app.email_extract import extract_doubles_pair, extract_name_usta_pairs
from app.importer import _parse_pdf_emails
from app.triage import classify

_PDF = Path(__file__).parent / "fixtures" / "tournament_emails.pdf"
_ROWS = _parse_pdf_emails(_PDF.read_bytes())


def _find(needle: str) -> dict:
    # Match on subject OR body — some subjects repeat across a thread
    # ("Re: Macon L3 Doubles" appears twice), so a body token disambiguates.
    n = needle.lower()
    for r in _ROWS:
        d = r["data"]
        if n in (d["subject"] or "").lower() or n in (d["body"] or "").lower():
            return d
    raise AssertionError(f"no corpus email matching {needle!r}")


def test_corpus_parses_every_page():
    # One email per page; every one has a subject + a non-empty body.
    assert len(_ROWS) == 30
    assert all(r["data"]["subject"] for r in _ROWS)
    assert all(r["data"]["body"] for r in _ROWS)


def test_corpus_classification_split():
    from collections import Counter
    counts = Counter(classify(r["data"]["subject"], r["data"]["body"]) for r in _ROWS)
    # The export is all withdrawals + doubles requests. (Two "…Doubles" threads
    # that merely *mention* a player withdrawing read as doubles, not withdrawal.)
    assert counts["withdrawal"] == 9
    assert counts["doubles"] == 21


def test_corpus_doubles_pairs_extractable():
    # On most doubles emails we can pull BOTH players — either two names joined
    # by a pairing connector, or two (name, USTA#) pairs. Guard against drift
    # below the level reached when this net was written.
    extractable = 0
    for r in _ROWS:
        d = r["data"]
        if classify(d["subject"], d["body"]) != "doubles":
            continue
        pair = extract_doubles_pair(d["subject"], d["body"])
        nu = extract_name_usta_pairs(d["subject"], d["body"])
        if len(pair) == 2 or len(nu) >= 2:
            extractable += 1
    assert extractable >= 13


def test_doubles_pairing_request_mentioning_withdraw_classifies_as_doubles():
    # The reported bug: a pairing request that merely *mentions* a third player
    # withdrawing must read as doubles, not withdrawal.
    assert classify("Macon L3 Doubles",
        "Can you please pair Zaria and Everly for doubles? Everly's initial "
        "partner, Zeal, is withdrawing from doubles.") == "doubles"
    assert classify("Re: Macon L3 Doubles",
        "Good morning, Everly Cogdell and Zaria Wadawu. Doubles partners L3 "
        "Macon. Thank you, Angelo Cogdell") == "doubles"
    # …but a real withdrawal still wins even though it says "doubles".
    assert classify("L3 Southern - Withdrawal Request",
        "Zeal Reynolds will be unable to participate. Please withdraw her "
        "from singles and doubles.") == "withdrawal"


def test_corpus_body_does_not_bleed_into_next_email():
    # USTA-portal exports stack several emails per page. A *singles* withdrawal's
    # body used to absorb the following *doubles* email's "Subject:" header,
    # poisoning event extraction (Singles → "Singles, Doubles"). The footer cut
    # stops the body at the USTA portal footer.
    from app.email_extract import extract_events
    d = _find("Ashvath Chamarthi has requested")   # the singles withdrawal
    assert "WITHDRAWAL REQUEST: Anvith" not in d["body"]      # next email's subject gone
    assert "You are receiving this message" not in d["body"]  # footer cut
    assert extract_events(d["subject"], d["body"]) == "Singles"


def test_corpus_specific_pairs():
    # Name-only pair (connector).
    assert extract_doubles_pair(*_two("Confirmed partnership")) == \
        ["Everly Cogdell", "Zaria Wadawu"]
    # Name + USTA # for each player (parenthesized) — disambiguate the repeated
    # "Re: Macon L3 Doubles" subject via a body token.
    hosch = extract_name_usta_pairs(*_two("Kai Hosch"))
    assert {"name": "Kai Hosch", "usta": "2019209285"} in hosch
    assert {"name": "Gabriel Zingman", "usta": "2019461037"} in hosch
    # Bulleted "name USTA# number".
    hampton = extract_name_usta_pairs(*_two("Cooper Rutledge"))
    assert {"name": "Kate Hampton", "usta": "2018840232"} in hampton
    assert {"name": "Cooper Rutledge", "usta": "2017193466"} in hampton


def _two(subject_substr: str):
    d = _find(subject_substr)
    return d["subject"], d["body"]
