"""Local tiny-LLM leftover parser (D5). Pure + monkeypatched HTTP — no GGUF."""
import json
from pathlib import Path

import pytest

from app.email_llm import (
    _SYSTEM,
    _assert_local_url,
    clip_email_text,
    extract_email,
    leftover_prompt,
    llm_enabled,
    llm_health_url,
    llm_url_allowed,
    maybe_intent,
    parse_llm_json,
    probe_llm,
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
    llm.leftover_model_intent("S", "Body one", bypass_cache=True)
    assert n["calls"] == 1
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


# --------------------------------------------------------------------------
# Small-LLM provider: DeepSeek by default, local sidecar behind a flag.
# Every test here is offline — the transport is monkeypatched.
# --------------------------------------------------------------------------

def _capture(monkeypatch, content='{"intent":"other","players":[],"confidence":0.5}'):
    """Patch the transport seam and return the dict the request lands in."""
    seen = {}

    class _Resp:
        def read(self):
            return json.dumps({"choices": [{"message": {"content": content}}]}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _urlopen(req, timeout=0):
        seen["url"] = req.full_url
        seen["auth"] = req.headers.get("Authorization")
        seen["body"] = json.loads(req.data.decode())
        seen["timeout"] = timeout
        return _Resp()

    monkeypatch.setattr("app.email_llm.urllib.request.urlopen", _urlopen)
    return seen


def test_default_provider_is_deepseek(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("EMAIL_LLM_MODEL", raising=False)
    from app import email_llm
    assert email_llm.llm_provider() == "deepseek"
    assert email_llm.llm_base_url() == "https://api.deepseek.com/v1"
    assert email_llm.llm_model() == "deepseek-flash"
    assert email_llm.is_deepseek_url(email_llm.llm_base_url()) is True


def test_provider_flag_switches_to_the_local_sidecar(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("EMAIL_LLM_MODEL", raising=False)
    from app import email_llm
    for value in ("local", "sidecar", "llama", "on-box", "LOCAL"):
        monkeypatch.setenv("EMAIL_LLM_PROVIDER", value)
        assert email_llm.llm_provider() == "local", value
        assert email_llm.llm_base_url() == "http://127.0.0.1:8080/v1"
        assert email_llm.llm_model() == "qwen2.5-1.5b-instruct"
        assert email_llm.is_deepseek_url(email_llm.llm_base_url()) is False
    # An unrecognized value keeps the documented default rather than guessing.
    monkeypatch.setenv("EMAIL_LLM_PROVIDER", "deepseak")
    assert email_llm.llm_provider() == "deepseek"
    assert email_llm.llm_base_url() == "https://api.deepseek.com/v1"


def test_explicit_base_url_and_model_win_over_the_flag(monkeypatch):
    monkeypatch.setenv("EMAIL_LLM_PROVIDER", "local")
    monkeypatch.setenv("EMAIL_LLM_BASE_URL", "http://courtops-llm.internal:8080/v1")
    monkeypatch.setenv("EMAIL_LLM_MODEL", "custom-model")
    from app import email_llm
    assert email_llm.llm_base_url() == "http://courtops-llm.internal:8080/v1"
    assert email_llm.llm_model() == "custom-model"
    # The model default follows the resolved host, not the flag alone.
    monkeypatch.delenv("EMAIL_LLM_MODEL", raising=False)
    assert email_llm.llm_model() == "qwen2.5-1.5b-instruct"


def test_deepseek_request_shape(monkeypatch):
    """The shipped client POSTs the DeepSeek endpoint with the env key."""
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.delenv("EMAIL_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("EMAIL_LLM_MODEL", raising=False)
    monkeypatch.setenv("EMAIL_LLM_TOKEN", "sidecar-token-must-not-be-used")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-deepseek-key")
    seen = _capture(monkeypatch)

    raw = extract_email("Re: Partner", "Jane Roe and Alex Kim would like to be partners.")
    assert raw is not None
    assert seen["url"] == "https://api.deepseek.com/v1/chat/completions"
    assert seen["auth"] == "Bearer unit-test-deepseek-key"
    assert seen["body"]["model"] == "deepseek-flash"
    assert seen["body"]["temperature"] == 0
    assert seen["body"]["max_tokens"] == 192
    assert seen["body"]["messages"][0]["content"] == _SYSTEM
    assert "Jane Roe and Alex Kim" in seen["body"]["messages"][1]["content"]


def test_local_provider_request_shape(monkeypatch):
    """The flag keeps the llama.cpp sidecar path working, with its own token."""
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setenv("EMAIL_LLM_PROVIDER", "local")
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.setenv("EMAIL_LLM_TOKEN", "dev-local-llm")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-deepseek-key")
    seen = _capture(monkeypatch)

    extract_email("Re: Partner", "pair them")
    assert seen["url"] == "http://127.0.0.1:8080/v1/chat/completions"
    assert seen["auth"] == "Bearer dev-local-llm"
    assert seen["body"]["model"] == "qwen2.5-1.5b-instruct"


def test_td_chat_planner_uses_the_same_client(monkeypatch):
    """td_chat.chat_complete goes through email_llm's transport, so the planner
    reaches DeepSeek too (same host, model and key) with its own prompt."""
    from app import td_chat
    monkeypatch.delenv("EMAIL_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("EMAIL_LLM_MODEL", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-deepseek-key")
    seen = _capture(monkeypatch, content="hi")

    assert td_chat.chat_complete("plan this") == "hi"
    assert seen["url"] == "https://api.deepseek.com/v1/chat/completions"
    assert seen["auth"] == "Bearer unit-test-deepseek-key"
    assert seen["body"]["model"] == "deepseek-flash"
    assert seen["body"]["messages"][0]["content"] == td_chat.PLANNER_SYSTEM
    assert seen["body"]["max_tokens"] == 256


def test_api_key_resolution_order(monkeypatch, tmp_path):
    from app import email_llm
    monkeypatch.delenv("EMAIL_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("EMAIL_LLM_TOKEN", raising=False)

    # 1. DEEPSEEK_API_KEY wins for the DeepSeek endpoint, and the sidecar's own
    #    token is never crossed over to the public API.
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-deepseek-key")
    monkeypatch.setenv("EMAIL_LLM_TOKEN", "sidecar-token")
    assert email_llm.llm_api_key() == "unit-test-deepseek-key"
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    assert email_llm.llm_api_key() == ""          # not the sidecar token

    # 2. The Grok config's declared env var is the local fallback.
    cfg = tmp_path / "config.toml"
    cfg.write_text(
        '[model.deepseek-flash]\n'
        'base_url = "https://api.deepseek.com/v1"\n'
        'env_key = "DEEPSEEK_API_KEY"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("GROK_CONFIG", str(cfg))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-key-via-grok-env-key")
    assert email_llm.llm_api_key() == "unit-test-key-via-grok-env-key"

    # 3. A config that carries the value itself is used directly.
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    cfg.write_text(
        '[model.deepseek-flash]\n'
        'base_url = "https://api.deepseek.com/v1"\n'
        'api_key = "unit-test-key-in-config"\n',
        encoding="utf-8",
    )
    assert email_llm.llm_api_key() == "unit-test-key-in-config"

    # 4. A missing / unreadable / unrelated config leaves nothing.
    monkeypatch.setenv("GROK_CONFIG", str(tmp_path / "nope.toml"))
    assert email_llm.llm_api_key() == ""
    cfg.write_text('[model.other]\nbase_url = "https://example.com/v1"\n', encoding="utf-8")
    monkeypatch.setenv("GROK_CONFIG", str(cfg))
    assert email_llm.llm_api_key() == ""
    cfg.write_text("this is not = valid toml [[[", encoding="utf-8")
    assert email_llm.llm_api_key() == ""

    # 5. The sidecar path only ever uses EMAIL_LLM_TOKEN.
    monkeypatch.setenv("GROK_CONFIG", str(tmp_path / "nope.toml"))
    monkeypatch.setenv("EMAIL_LLM_TOKEN", "dev-local-llm")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-deepseek-key")
    assert email_llm.llm_api_key("http://127.0.0.1:8080/v1") == "dev-local-llm"
    assert email_llm.llm_api_key("https://api.deepseek.com/v1") == "unit-test-deepseek-key"


def test_grok_config_shape_edges(monkeypatch, tmp_path):
    """A config without a [model] table, or with a non-table entry, yields
    nothing — it must not raise on a hand-edited file."""
    from app import email_llm
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("EMAIL_LLM_TOKEN", raising=False)
    # Pass the endpoint explicitly: other suites set EMAIL_LLM_BASE_URL globally.
    cfg = tmp_path / "config.toml"

    cfg.write_text('model = "not-a-table"\n', encoding="utf-8")
    monkeypatch.setenv("GROK_CONFIG", str(cfg))
    assert email_llm.llm_api_key("https://api.deepseek.com/v1") == ""

    cfg.write_text(
        '[model]\n'
        'plain = "not a table entry"\n'
        '\n'
        '[model.deepseek-flash]\n'
        'base_url = "https://api.deepseek.com/v1"\n'
        'api_key = "unit-test-key-in-config"\n',
        encoding="utf-8",
    )
    assert email_llm.llm_api_key("https://api.deepseek.com/v1") == "unit-test-key-in-config"


def test_deepseek_host_allowed_by_default_others_still_refused(monkeypatch):
    monkeypatch.delenv("EMAIL_LLM_ALLOW_REMOTE", raising=False)
    assert llm_url_allowed("https://api.deepseek.com/v1") is True
    assert llm_url_allowed("https://api.deepseek.com") is True
    # The refusal for every other public host is unchanged.
    assert llm_url_allowed("https://api.x.ai/v1") is False
    assert llm_url_allowed("https://example.com/v1") is False
    assert llm_url_allowed("https://courtops-llm.fly.dev/v1") is False
    assert llm_url_allowed("https://api.x.ai/v1", allow_remote=True) is True
    # The opt-in is not needed for DeepSeek, and is not required to be set.
    _assert_local_url("https://api.deepseek.com/v1")
    with pytest.raises(RuntimeError, match="DeepSeek API"):
        _assert_local_url("https://example.com/v1")


def test_deepseek_health_url_is_models_not_llama_health():
    assert llm_health_url("https://api.deepseek.com/v1") == "https://api.deepseek.com/v1/models"
    assert llm_health_url("http://127.0.0.1:8080/v1") == "http://127.0.0.1:8080/health"
    assert llm_health_url("http://courtops-llm.internal:8080/v1") == (
        "http://courtops-llm.internal:8080/health"
    )


def test_probe_deepseek_states(monkeypatch):
    """ok / down / off for the DeepSeek endpoint, and inert without a key."""
    from app import email_llm
    monkeypatch.delenv("EMAIL_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("EMAIL_LLM", raising=False)
    assert probe_llm() == "off"

    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-deepseek-key")
    seen = {}

    class _Ok:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _urlopen(req, timeout=0):
        seen["url"] = req.full_url
        seen["auth"] = req.headers.get("Authorization")
        return _Ok()

    monkeypatch.setattr("app.email_llm.urllib.request.urlopen", _urlopen)
    assert probe_llm() == "ok"
    assert seen["url"] == "https://api.deepseek.com/v1/models"
    assert seen["auth"] == "Bearer unit-test-deepseek-key"

    def _boom(*a, **k):
        raise TimeoutError("nope")

    monkeypatch.setattr("app.email_llm.urllib.request.urlopen", _boom)
    assert probe_llm() == "down"

    # No key on the DeepSeek endpoint: inert, and no request is attempted.
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("GROK_CONFIG", "C:/definitely/not/here.toml")
    monkeypatch.delenv("EMAIL_LLM_TOKEN", raising=False)
    monkeypatch.setattr("app.email_llm.urllib.request.urlopen",
                        lambda *a, **k: pytest.fail("probe must not make a request without a key"))
    assert probe_llm() == "down"
    assert email_llm.llm_api_key() == ""


def test_post_chat_omits_authorization_without_a_key(monkeypatch):
    """A keyless sidecar keeps working; no empty Bearer header is sent."""
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setenv("EMAIL_LLM_PROVIDER", "local")
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("EMAIL_LLM_TOKEN", raising=False)
    seen = _capture(monkeypatch)
    extract_email("s", "b")
    assert seen["auth"] is None


def test_health_endpoint_stays_ok_with_llm_down(monkeypatch):
    """Site health is `ok` while the small LLM is unreachable."""
    from fastapi.testclient import TestClient

    from app.main import app
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.delenv("EMAIL_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("EMAIL_LLM_BASE_URL", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-deepseek-key")

    def _boom(*a, **k):
        raise TimeoutError("nope")

    monkeypatch.setattr("app.email_llm.urllib.request.urlopen", _boom)
    c = TestClient(app)
    r = c.get("/api/health")
    assert r.status_code == 200
    assert r.json()["llm"] == "down"
    assert c.get("/api/health/llm").json()["status"] == "down"
