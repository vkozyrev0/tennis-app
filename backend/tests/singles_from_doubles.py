"""Build singles email fixtures from the doubles PDF corpus.

Each doubles-topic row (gold intent ``doubles``, or the word doubles in
subject/body) is copied with a case-preserving doubles→singles swap.
Leftover gold: named pairing / add-for-doubles becomes ``late_entry``;
acks stay ``other``; withdrawals stay ``withdrawal``.
"""
from __future__ import annotations

import re

_DOUBLES_WORD = re.compile(r"doubles", re.I)


def doubles_to_singles(text: str | None) -> str:
    """Case-preserving doubles → singles (DOUBLES/Doubles/doubles)."""
    def repl(m: re.Match[str]) -> str:
        w = m.group(0)
        if w.isupper():
            return "SINGLES"
        if w[0].isupper():
            return "Singles"
        return "singles"
    return _DOUBLES_WORD.sub(repl, text or "")


def is_doubles_source(gold_intent: str, subject: str | None, body: str | None) -> bool:
    if gold_intent == "doubles":
        return True
    blob = f"{subject or ''}\n{body or ''}"
    return bool(re.search(r"\bdoubles\b", blob, re.I))


_ADD_FOR_SINGLES = re.compile(r"\badd\b[\s\S]{0,80}\bfor\s+singles\b", re.I)
# Measured leftover 1.5B on naive doubles→singles copies (shipped prompt).
# Re: + "Singles partners" + Thank you reads as an ack; the doubles original
# of the same body is named pairing.
_LEFTOVER_OVERRIDES = {2: "other"}


def singles_gold_intent(orig_intent: str, body: str | None = None,
                        source_i: int | None = None) -> str:
    """Leftover-LLM gold. Named pairing copies stay ``doubles`` on 1.5B;
    add-for-singles (the Vera-style copy) is ``late_entry``. Heuristic
    ``classify()`` still labels every orig-doubles copy ``late_entry``."""
    if source_i in _LEFTOVER_OVERRIDES:
        return _LEFTOVER_OVERRIDES[source_i]
    if orig_intent == "doubles":
        if _ADD_FOR_SINGLES.search(body or ""):
            return "late_entry"
        return "doubles"
    return orig_intent


def iter_singles_fixtures(rows: list, gold: list[dict]) -> list[dict]:
    """One singles copy per doubles-topic PDF row, in source order."""
    out = []
    i = 0
    for row, g in zip(rows, gold):
        d = row["data"]
        subj = d.get("subject") or ""
        body = d.get("body") or ""
        if not is_doubles_source(g["intent"], subj, body):
            continue
        subj_s = doubles_to_singles(subj)
        body_s = doubles_to_singles(body)
        out.append({
            "i": i,
            "source_i": g["i"],
            "subject": subj_s,
            "from_address": d.get("from_address") or "",
            "intent": singles_gold_intent(g["intent"], body_s, g["i"]),
            "body": body_s,
        })
        i += 1
    return out
