"""Local tiny-LLM leftover parser (D5). Pure + monkeypatched HTTP — no GGUF."""
import os

import pytest

from app.email_llm import (
    clip_email_text,
    extract_email,
    llm_enabled,
    llm_health_url,
    llm_url_allowed,
    maybe_intent,
    parse_llm_json,
    probe_llm,
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
