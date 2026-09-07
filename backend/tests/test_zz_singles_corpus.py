"""Singles copies of the doubles PDF corpus — heuristic + leftover LLM.

Each doubles-topic email is rewritten doubles→singles. Regex ``classify()``
must not call those copies doubles; leftover gold maps named pairing /
add-for-doubles to ``late_entry``.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.email_llm import INTENTS, leftover_model_intent, probe_llm
from app.importer import _parse_pdf_emails
from app.triage import classify
from tests.singles_from_doubles import doubles_to_singles, iter_singles_fixtures

_PDF = Path(__file__).parent / "fixtures" / "tournament_emails.pdf"
_GOLD_PATH = Path(__file__).parent / "fixtures" / "tournament_emails_gold.json"
_GOLD = json.loads(_GOLD_PATH.read_text(encoding="utf-8"))
_SINGLES_GOLD_PATH = Path(__file__).parent / "fixtures" / "tournament_emails_singles_gold.json"
_SINGLES_GOLD = json.loads(_SINGLES_GOLD_PATH.read_text(encoding="utf-8"))
_ROWS = _parse_pdf_emails(_PDF.read_bytes())
_SINGLES = iter_singles_fixtures(_ROWS, _GOLD)


def test_every_doubles_row_has_a_singles_copy():
    doubles_src = [g["i"] for g in _GOLD if g["intent"] == "doubles"]
    copied = {s["source_i"] for s in _SINGLES}
    assert doubles_src, "expected doubles gold in the PDF corpus"
    assert copied >= set(doubles_src)
    assert len(_SINGLES) >= len(doubles_src)
    for s in _SINGLES:
        assert "doubles" not in s["subject"].lower()
        assert s["intent"] in INTENTS
    assert len(_SINGLES) == len(_SINGLES_GOLD)
    for s, g in zip(_SINGLES, _SINGLES_GOLD):
        assert s["source_i"] == g["source_i"]
        assert s["subject"] == g["subject"]
        assert s["from_address"] == g["from_address"]
        assert s["intent"] == g["intent"]


def test_singles_copies_never_classify_as_doubles(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM", raising=False)
    assert _SINGLES
    for s in _SINGLES:
        got = classify(s["subject"], s["body"])
        assert got != "doubles", (
            f"source {s['source_i']} {s['subject']!r} classified doubles"
        )


def test_named_singles_pairing_and_add_are_late_entry(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM", raising=False)
    named = [s for s in _SINGLES if _GOLD[s["source_i"]]["intent"] == "doubles"]
    assert named, "expected singles copies of leftover-gold doubles emails"
    for s in named:
        got = classify(s["subject"], s["body"])
        assert got == "late_entry", (
            f"source {s['source_i']} {s['subject']!r} want late_entry got {got}"
        )


def test_singles_withdrawal_copies_stay_withdrawal(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM", raising=False)
    wds = [s for s in _SINGLES if s["intent"] == "withdrawal"]
    assert wds
    for s in wds:
        assert classify(s["subject"], s["body"]) == "withdrawal"


def test_event_title_singles_is_not_doubles(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM", raising=False)
    assert classify("Southerns Boys 14 Singles", "") != "doubles"
    assert classify("Southerns Boys 14 Singles", "Thank you") != "doubles"
    assert classify(
        "Boys 14s Singles Confirmation-Level 3 Macon",
        "Please confirm Scarlett Milner for singles.",
    ) == "late_entry"
    assert classify(
        "Vera Pantovic",
        "Can you add Vera for singles maybe for southerns, if it's not too late.",
    ) == "late_entry"
    assert classify(
        "Macon L3 - G14 singles",
        "Alexandra Dimitrov and Casey Davis would like to play G14 singles.",
    ) == "late_entry"
    # The un-copied doubles original still classifies as doubles.
    assert classify("Southerns Boys 14 Doubles", "") == "doubles"


def test_doubles_to_singles_preserves_case():
    assert doubles_to_singles("G14 doubles") == "G14 singles"
    assert doubles_to_singles("G14 Doubles") == "G14 Singles"
    assert doubles_to_singles("G14 DOUBLES") == "G14 SINGLES"


def _sidecar_ready() -> bool:
    os.environ.setdefault("EMAIL_LLM", "1")
    os.environ.setdefault("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
    os.environ.setdefault("EMAIL_LLM_TOKEN", "dev-local-llm")
    os.environ.setdefault("EMAIL_LLM_TIMEOUT", "60")
    return probe_llm(timeout=5) == "ok"


@pytest.mark.skipif(not _sidecar_ready(), reason="local llama.cpp sidecar not reachable")
@pytest.mark.parametrize(
    "i",
    [s["i"] for s in _SINGLES],
    ids=[f"{s['i']:02d}-src{s['source_i']:02d}-{s['intent']}" for s in _SINGLES],
)
def test_tiny_llm_singles_copy_matches_gold(i):
    os.environ["EMAIL_LLM"] = "1"
    s = _SINGLES[i]
    parsed = leftover_model_intent(s["subject"], s["body"])
    assert parsed is not None, f"singles {i} leftover_model_intent returned None"
    assert parsed["intent"] == s["intent"], (
        f"singles {i} source={s['source_i']} subject={s['subject']!r} "
        f"want={s['intent']} got={parsed.get('intent')} raw={parsed}"
    )
