"""Shared t-shirt size normalization (audit A51).

Used by both `roster.py` (CSV import + form submit) and `importer.py` (the
staged Part-B importer). Keeping the canonical labels in one module means
the frontend roster grid editor, the t-shirt order summary, and the import
pipeline can never drift in spelling.
"""
import re


# Canonical t-shirt size labels (must match the roster form dropdown).
SHIRT_LABELS = [
    "Youth Small", "Youth Medium", "Youth Large",
    "Adult Small", "Adult Medium", "Adult Large", "Adult Extra Large",
]

_SHIRT_CANON = {
    ("youth", "small"): "Youth Small", ("youth", "medium"): "Youth Medium",
    ("youth", "large"): "Youth Large", ("adult", "small"): "Adult Small",
    ("adult", "medium"): "Adult Medium", ("adult", "large"): "Adult Large",
    ("adult", "xl"): "Adult Extra Large",
}
_SHIRT_SIZE = {
    "s": "small", "sm": "small", "small": "small",
    "m": "medium", "med": "medium", "medium": "medium",
    "l": "large", "lg": "large", "large": "large",
    "xl": "xl", "xlarge": "xl", "extralarge": "xl", "xxl": "xl", "xxxl": "xl",
}


def norm_shirt(v):
    """Normalize a free-text t-shirt size (abbreviated or full) to a canonical
    label; unrecognized values pass through unchanged so nothing is lost."""
    if v is None:
        return None
    raw = str(v).strip()
    s = re.sub(r"[^a-z]", "", raw.lower())  # 'Youth M' -> 'youthm', 'YM' -> 'ym'
    if not s:
        return raw or None
    # Split off a youth/adult marker; default to adult when none is given.
    if s.startswith(("youth", "yth", "junior", "jr")) or (s[0] == "y" and len(s) <= 4):
        group, rest = "youth", re.sub(r"^(youth|yth|junior|jr|y)", "", s, count=1)
    elif s.startswith("adult") or (s[0] == "a" and len(s) <= 4):
        group, rest = "adult", re.sub(r"^(adult|a)", "", s, count=1)
    else:
        group, rest = "adult", s
    size = _SHIRT_SIZE.get(rest)
    return _SHIRT_CANON.get((group, size), raw)
