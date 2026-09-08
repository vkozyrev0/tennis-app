"""Local tiny-LLM leftover parser (D5). Pure + monkeypatched HTTP — no GGUF."""
import json
import os
from pathlib import Path

import pytest

from app.email_llm import (
    clip_email_text,
    extract_email,
    leftover_prompt,
    llm_enabled,
    llm_health_url,
    llm_url_allowed,
    maybe_intent,
    parse_llm_json,
    probe_llm,
    _SYSTEM,
    _assert_local_url,
)
from app.triage import classify


def test_health_llm_endpoint_off(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM", raising=False)
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    r = c.get("/api/health/llm")
    assert r.status_code == 200
    assert r.json()["status"] == "off"


def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM", raising=False)
    assert llm_enabled() is False
    assert maybe_intent("x", "y", "other") == "other"


def test_parse_llm_json_accepts_fenced_and_bare():
    raw = '```json\n{"intent":"doubles","players":[{"name":"Kai Hosch"}],"confidence":0.8}\n```'
    p = parse_llm_json(raw)
    assert p["intent"] == "doubles"
    assert p["players"][0]["name"] == "Kai Hosch"
    assert p["confidence"] == 0.8
    assert parse_llm_json("not json") is None
    assert parse_llm_json('{"intent":"bananas"}')["intent"] == "other"


def test_parse_llm_json_accepts_player1_player2():
    p = parse_llm_json(
        '{"intent":"doubles","player1":{"name":"Jane Roe","usta":"2018111222"},'
        '"player2":{"name":"Alex Kim","usta":null},"confidence":0.9}'
    )
    assert p["players"] == [
        {"name": "Jane Roe", "usta": "2018111222"},
        {"name": "Alex Kim", "usta": None},
    ]


def test_leftover_system_asks_for_players_after_equal_intents():
    assert "Treat those intents equally" in _SYSTEM
    assert "do not prefer doubles" in _SYSTEM
    assert "players[0] first named player" in _SYSTEM
    assert "players[1] only if a second player is named" in _SYSTEM


def test_clip_drops_outlook_and_iphone_signatures():
    _, body = clip_email_text("Re: Partner", "We will pair them.\nGet Outlook for iOS")
    assert body.strip() == "We will pair them."
    _, body2 = clip_email_text("Re: Hi", "Thank you!\nSent from my iPhone")
    assert body2.strip() == "Thank you!"
    _, body3 = clip_email_text(
        "Re: Partners",
        "Alex and Sam Doubles partners Thank you\n"
        "On Wed, May 27, 2026 at 9:58 PM, Pat\n<pat@example.com> wrote:\nquoted",
    )
    assert "quoted" not in body3
    assert "Doubles partners" in body3


def test_clip_drops_pdf_date_to_wrapper():
    subj, body = clip_email_text(
        "Re: August Baklini withdrawal",
        "[Date: Thursday, May 28, 2026 at 15:15:53 Eastern Daylight Time]\n"
        "[To: Devyn Baklini]\n\nThanks.",
    )
    assert body.strip() == "Thanks."
    assert "Date:" not in body


def test_clip_strips_quoted_thread():
    subj, body = clip_email_text(
        "Re: Doubles",
        "Please pair A and B.\nOn Mon, Jane wrote:\n> old thread\nFrom: x\n",
    )
    assert "Please pair A and B." in body
    assert "old thread" not in body
    assert "From:" not in body


def test_loopback_required(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM_ALLOW_REMOTE", raising=False)
    _assert_local_url("http://127.0.0.1:8080/v1")
    with pytest.raises(RuntimeError, match="private"):
        _assert_local_url("https://api.x.ai/v1")


def test_fly_internal_dns_allowed_public_hosts_not():
    assert llm_url_allowed("http://courtops-llm.internal:8080/v1") is True
    assert llm_url_allowed("http://llm.process.courtops-poc.internal:8080/v1") is True
    assert llm_url_allowed("http://courtops-llm.flycast:8080") is True
    assert llm_url_allowed("http://[fdaa:1:2:3::1]:8080/v1") is True
    assert llm_url_allowed("https://courtops-llm.fly.dev/v1") is False
    assert llm_url_allowed("https://api.x.ai/v1") is False
    assert llm_url_allowed("https://api.x.ai/v1", allow_remote=True) is True


def test_health_url_strips_v1():
    assert llm_health_url("http://127.0.0.1:8080/v1") == "http://127.0.0.1:8080/health"
    assert llm_health_url("http://courtops-llm.internal:8080/v1") == (
        "http://courtops-llm.internal:8080/health"
    )
    assert llm_health_url("http://llm:8080/v1") == "http://llm:8080/health"


def test_probe_llm_off_ok_down(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM", raising=False)
    assert probe_llm() == "off"

    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setenv("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1")

    class _Ok:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    monkeypatch.setattr("app.email_llm.urllib.request.urlopen", lambda *a, **k: _Ok())
    assert probe_llm() == "ok"

    def _boom(*a, **k):
        raise TimeoutError("nope")
    monkeypatch.setattr("app.email_llm.urllib.request.urlopen", _boom)
    assert probe_llm() == "down"


def test_compose_hosts_allowed_in_dev(monkeypatch):
    monkeypatch.setenv("ENV", "dev")
    assert llm_url_allowed("http://llm:8080/v1") is True
    assert llm_url_allowed("http://host.docker.internal:8080/v1") is True
    monkeypatch.setenv("ENV", "prod")
    assert llm_url_allowed("http://llm:8080/v1") is False


def test_leftover_prompt_is_one_shared_template():
    """Same leftover few-shots for every email — not a per-message prompt."""
    assert "doubles confirmation" in _SYSTEM.lower()
    a = leftover_prompt("Alpha subject", "Alpha body")
    b = leftover_prompt("Beta subject", "Beta body")
    assert a.replace("Alpha subject", "X").replace("Alpha body", "Y") == \
        b.replace("Beta subject", "X").replace("Beta body", "Y")
    assert a.count("Now extract") == 1
    assert '{"intent":"withdrawal"' in a
    assert '{"intent":"doubles"' in a
    assert '{"intent":"late_entry"' in a
    assert '{"intent":"other"' in a
    assert "enter jordan blake in singles" in a.lower()
    assert a.count("{subject}") == 0


def test_docs_inventory_cites_shipped_inbox_idle_mail():
    """docs/README + data-model + test-coverage must name live surfaces."""
    root = Path(__file__).resolve().parents[2]
    readme = (root / "docs" / "README.md").read_text(encoding="utf-8")
    # docker-compose mounts backend/ not docs/; the baked image README still
    # says 0055. CI copies the tree, so 0060 must be present there.
    if "migrations through **0055**" in readme and "0060" not in readme:
        pytest.skip("docs/ not mounted in this environment")
    model = (root / "docs" / "data-model.md").read_text(encoding="utf-8")
    coverage = (root / "docs" / "test-coverage.md").read_text(encoding="utf-8")
    ingest = (root / "docs" / "email-ingest.md").read_text(encoding="utf-8")
    assert "0060" in readme
    assert "inbox people" in readme.lower() or "inbox_person" in readme
    assert "Still there?" in readme
    assert "inbox_person" in model
    assert "outlook_feed" in model
    assert "deleted_at" in model
    assert "985" in coverage
    assert "test_zz_inbox_people" in coverage
    assert "Get all" in ingest
    assert "outlook" in ingest.lower()


def test_docs_quote_shipped_leftover_prompt():
    """docs/email-llm-prompt.md must quote the live _SYSTEM and _SHOTS."""
    from app.email_llm import _SHOTS
    doc = (Path(__file__).resolve().parents[2] / "docs" / "email-llm-prompt.md")
    text = doc.read_text(encoding="utf-8")
    assert _SYSTEM in text
    assert "Jane Roe has requested to be withdrawn" in text
    assert "Alex Kim and Sam Lee would like to be doubles partners" in text
    assert "Now extract" in text
    assert "Subject: {subject}" in text
    assert "Body: {body}" in text
    for line in _SHOTS.strip().splitlines():
        if line.startswith("Subject: {") or line.startswith("Body: {"):
            continue
        if line.strip():
            assert line in text, line


def test_leftover_shots_are_not_corpus_emails():
    """Generic invented examples only — must not paste the PDF subjects."""
    gold_path = Path(__file__).parent / "fixtures" / "tournament_emails_gold.json"
    gold = json.loads(gold_path.read_text(encoding="utf-8"))
    blob = _SYSTEM + "\n" + leftover_prompt("QUERY_SUBJECT", "QUERY_BODY")
    blob = blob.replace("QUERY_SUBJECT", "").replace("QUERY_BODY", "")
    shot_subjects = [
        line[len("Subject: "):] for line in blob.splitlines()
        if line.startswith("Subject: ")
    ]
    for g in gold:
        assert g["subject"] not in shot_subjects, g["subject"]


def test_leftover_model_intent_caches_same_clip(monkeypatch):
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setenv("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
    n = {"calls": 0}

    def fake_complete(prompt):
        n["calls"] += 1
        return '{"intent":"doubles","players":[{"name":"Jane Roe"}],"confidence":0.9}'

    monkeypatch.setattr("app.email_llm._complete", fake_complete)
    import app.email_llm as llm
    llm._LEFTOVER_LAST = None
    a = llm.leftover_model_intent("S", "Body one")
    b = llm.leftover_model_intent("S", "Body one")
    assert a["intent"] == "doubles"
    assert b is a
    assert n["calls"] == 1
    llm.leftover_model_intent("S", "Body two")
    assert n["calls"] == 2
    n["calls"] = 0

    def boom(prompt):
        n["calls"] += 1
        raise TimeoutError("nope")

    monkeypatch.setattr("app.email_llm._complete", boom)
    llm._LEFTOVER_LAST = None
    assert llm.leftover_model_intent("Sx", "Bx") is None
    assert llm.leftover_model_intent("Sx", "Bx") is None
    assert n["calls"] == 1
    llm._LEFTOVER_LAST = None


def test_extract_formats_prompt_without_eating_json_braces(monkeypatch):
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setenv("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
    captured = {}

    def fake_complete(prompt):
        captured["p"] = prompt
        return '{"intent":"doubles","players":[{"name":"Kai Hosch"}],"confidence":0.9}'

    monkeypatch.setattr("app.email_llm._complete", fake_complete)
    p = extract_email("Re: L3 Doubles", "Please pair Kai Hosch and Gabriel Zingman for doubles.")
    assert "Re: L3 Doubles" in captured["p"]
    assert '{"intent":"withdrawal"' in captured["p"]
    assert p["intent"] == "doubles"


def test_hybrid_keeps_heuristic_and_upgrades_other(monkeypatch):
    monkeypatch.setenv("EMAIL_LLM", "1")

    def fake_extract(subject, body):
        return {"intent": "doubles", "players": [], "reason": None, "confidence": 0.9}

    monkeypatch.setattr("app.email_llm.extract_email", fake_extract)
    assert maybe_intent("Re: Doubles", "please pair them", "other") == "doubles"
    assert maybe_intent("Withdraw Jane", "please withdraw", "withdrawal") == "withdrawal"


def test_low_confidence_stays_other(monkeypatch):
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setattr(
        "app.email_llm.extract_email",
        lambda s, b: {"intent": "hotel", "players": [], "reason": None, "confidence": 0.2},
    )
    assert maybe_intent("Hi", "see you", "other") == "other"


def test_classify_calls_llm_only_for_other(monkeypatch):
    monkeypatch.setenv("EMAIL_LLM", "1")
    called = {"n": 0}

    def fake_extract(subject, body):
        called["n"] += 1
        return {"intent": "late_entry", "players": [], "reason": None, "confidence": 0.95}

    monkeypatch.setattr("app.email_llm.extract_email", fake_extract)
    assert classify("Thanks", "See you Saturday.") == "late_entry"
    assert called["n"] == 1
    assert classify("Please withdraw Maya Quintero from the event",
                    "Maya Quintero has requested to be withdrawn") == "withdrawal"
    assert called["n"] == 1  # heuristic already decided
