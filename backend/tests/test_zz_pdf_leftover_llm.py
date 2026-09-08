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
    INTENTS, extract_email, leftover_model_intent, leftover_prompt, probe_llm,
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


def test_extract_uses_shipped_leftover_prompt_builder():
    src = Path(__file__).resolve().parents[1] / "app" / "email_llm.py"
    text = src.read_text(encoding="utf-8")
    assert "def leftover_prompt(" in text
    assert "prompt = leftover_prompt(subj, clipped)" in text
    assert "parse_llm_json(raw)" in text
    assert "def leftover_model_intent(" in text
    assert "return leftover_model_intent(subject, body)" in text
    assert "guard_leftover_intent" not in text
    p = leftover_prompt("Subj X", "Body Y")
    assert "Subj X" in p and "Body Y" in p
    assert p.count("{subject}") == 0


def _sidecar_ready() -> bool:
    os.environ.setdefault("EMAIL_LLM", "1")
    os.environ.setdefault("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
    os.environ.setdefault("EMAIL_LLM_TOKEN", "dev-local-llm")
    os.environ.setdefault("EMAIL_LLM_TIMEOUT", "60")
    return probe_llm(timeout=5) == "ok"


@pytest.mark.skipif(not _sidecar_ready(), reason="local llama.cpp sidecar not reachable")
@pytest.mark.parametrize(
    "i",
    [g["i"] for g in _GOLD],
    ids=[f"{g['i']:02d}-{g['intent']}" for g in _GOLD],
)
def test_tiny_llm_intent_matches_gold(i):
    os.environ["EMAIL_LLM"] = "1"
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
