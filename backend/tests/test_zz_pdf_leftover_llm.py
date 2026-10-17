"""One leftover-LLM intent test per email parsed from tournament_emails.pdf.

Gold labels are the large-LLM reading of the *same* leftover prompt the tiny
model sees (not heuristic ``classify()``). Live sidecar required for extract.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.email_llm import (
    INTENTS,
    leftover_model_intent,
    probe_llm,
)
from app.importer import _parse_pdf_emails

_FIXTURE = Path(__file__).parent / "fixtures" / "tournament_emails.pdf"
_GOLD_PATH = Path(__file__).parent / "fixtures" / "tournament_emails_gold.json"
_GOLD = json.loads(_GOLD_PATH.read_text(encoding="utf-8"))


def _rows():
    return _parse_pdf_emails(_FIXTURE.read_bytes())


def test_pdf_splitter_one_email_per_gold_row():
    rows = _rows()
    assert len(rows) == len(_GOLD)
    assert len(rows) >= 1
    for i, (row, gold) in enumerate(zip(rows, _GOLD)):
        d = row["data"]
        assert gold["i"] == i
        assert d["subject"] == gold["subject"], (i, d["subject"], gold["subject"])
        assert (d.get("from_address") or "") == gold["from_address"]
        assert gold["intent"] in INTENTS


def test_gold_intents_are_leftover_intents():
    assert {g["intent"] for g in _GOLD} <= INTENTS
    assert all(g["intent"] in INTENTS for g in _GOLD)


def test_leftover_model_intent_uses_the_shipped_prompt(monkeypatch):
    """Behavior, not a source grep: the shipped builder is what reaches the
    transport, with the subject and body substituted in (D35)."""
    from app import email_llm

    seen = {}

    def fake_complete(prompt):
        seen["prompt"] = prompt
        return ('{"intent":"withdrawal",'
                '"players":[{"name":"Ann","usta":null}],"confidence":0.9}')

    monkeypatch.setattr(email_llm, "llm_enabled", lambda: True)
    monkeypatch.setattr(email_llm, "_complete", fake_complete)
    monkeypatch.setattr(email_llm, "budget_allows", lambda: True)
    monkeypatch.setattr(email_llm, "budget_spend", lambda: None)

    out = email_llm.leftover_model_intent(
        "Withdraw Ann", "Please withdraw Ann.", bypass_cache=True,
    )
    assert out["intent"] == "withdrawal"
    assert "Withdraw Ann" in seen["prompt"]
    assert "Please withdraw Ann." in seen["prompt"]
    assert "{subject}" not in seen["prompt"]


_SIDECAR_ENV = {
    "EMAIL_LLM": "1",
    "EMAIL_LLM_BASE_URL": "http://127.0.0.1:8080/v1",
    "EMAIL_LLM_TOKEN": "dev-local-llm",
    "EMAIL_LLM_TIMEOUT": "60",
}


def _sidecar_ready() -> bool:
    # Decoration-time probe: restore the process env after probing so the rest
    # of the suite does not run with the LLM path enabled.
    saved = {k: os.environ.get(k) for k in _SIDECAR_ENV}
    os.environ.update(_SIDECAR_ENV)
    try:
        return probe_llm(timeout=5) == "ok"
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@pytest.mark.skipif(not _sidecar_ready(), reason="local llama.cpp sidecar not reachable")
@pytest.mark.parametrize(
    "i",
    [g["i"] for g in _GOLD],
    ids=[f"{g['i']:02d}-{g['intent']}" for g in _GOLD],
)
def test_tiny_llm_intent_matches_gold(i, monkeypatch):
    for k, v in _SIDECAR_ENV.items():
        monkeypatch.setenv(k, v)
    rows = _rows()
    d = rows[i]["data"]
    gold = _GOLD[i]
    assert d["subject"] == gold["subject"]
    parsed = leftover_model_intent(d["subject"], d["body"])
    assert parsed is not None, f"email {i} leftover_model_intent returned None"
    assert parsed["intent"] == gold["intent"], (
        f"email {i} unguarded parse_llm_json subject={d['subject']!r} "
        f"want={gold['intent']} got={parsed.get('intent')} raw={parsed}"
    )
