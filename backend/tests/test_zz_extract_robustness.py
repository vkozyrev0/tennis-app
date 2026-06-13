"""Robustness guard for the pure email extractors (no DB).

The name/USTA regexes deliberately avoid nested same-class quantifiers (the
classic catastrophic-backtracking shape). This pins that property: every
extractor must COMPLETE quickly on adversarial input (a regex change that
introduces ReDoS would blow the time bound / hang) and must never crash on
malformed / unicode / huge input.
"""
import time

from app import email_extract as ex

# Inputs crafted to trip a poorly-written regex: long single tokens, thousands
# of near-matches, digit-run spam, dangling "USTA (" bait, unicode + smart
# quotes, and a wall of newlines before a real match.
_ADVERSARIAL = {
    "many_caps": "A " * 8000,
    "long_token": "B" + "a" * 40000,
    "usta_label_spam": "USTA " * 8000,
    "name_usta_bait": "Kate Hampton USTA# " * 4000,
    "digit_runs": "123456789 " * 8000,
    "paren_bait": "Ann Lee (USTA " * 4000,
    "unicode": "Renée O’Brien USTA# 2018840232 — café " * 2000,
    "newlines": ("\n" * 20000) + "Ethan Carter 21043871",
    "empty": "",
}

_EXTRACTORS = [
    ex.extract_usta, ex.usta_candidates, ex.extract_name_usta_pairs,
    ex.extract_ustas, ex.extract_withdrawal_reason, ex.extract_age_division,
    ex.extract_events, ex.extract_avoid_day, ex.extract_avoid_time,
]


def test_extractors_are_redos_safe_and_crash_free():
    for name, text in _ADVERSARIAL.items():
        for fn in _EXTRACTORS:
            t0 = time.perf_counter()
            fn("subject line", text)            # must not raise
            fn(text, None)                      # subject side + None body
            dt = time.perf_counter() - t0
            # Linear regexes finish in milliseconds; a ReDoS would take seconds.
            # 2s is lenient enough to never flake on a loaded CI box yet still
            # catch exponential blowup.
            assert dt < 2.0, f"{fn.__name__} too slow on {name}: {dt:.2f}s"


def test_extractors_handle_none_and_garbage():
    for fn in _EXTRACTORS:
        assert fn(None, None) in (None, [], "")          # no crash, empty-ish
    # binary-ish / control chars + lone surrogates-escaped text shouldn't crash
    garbage = "\x00\x01\x02 � USTA# 2018840232 \t\r meanwhile 12345"
    assert ex.extract_usta(None, garbage) == "2018840232"   # still finds labeled #
    assert isinstance(ex.usta_candidates(None, garbage), list)
