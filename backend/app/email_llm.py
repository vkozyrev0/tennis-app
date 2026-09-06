"""Optional local tiny-LLM assist for leftover inbox emails (D5).

Heuristic triage in ``triage.classify`` stays the default. When ``EMAIL_LLM=1``
and the heuristic returns ``other``, this module asks a llama.cpp
(OpenAI-compatible) server for a JSON intent.

Allowed destinations (COPPA / D5 — junior PII stays on our network):
  * loopback (same Machine)
  * Fly 6PN: ``*.internal``, ``*.flycast``, unique-local IPv6 (``fd00::/8``)
Public hosts (``*.fly.dev``, ``api.x.ai``, …) need ``EMAIL_LLM_ALLOW_REMOTE=1``.

Two Fly Machines are cheaper than one 4gb box (see ``fly.toml`` + ``fly.llm.toml``).
Skip cloud SpaceXAI/OpenAI for this path.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

INTENTS = frozenset({
    "withdrawal", "doubles", "late_entry", "pairing_avoidance",
    "scheduling_avoidance", "division_flex", "hotel", "other",
})

_SYSTEM = (
    "You extract structured facts from USTA junior/adult tournament emails. "
    "Reply with JSON only, no markdown. "
    "intent must be one of: withdrawal, doubles, late_entry, pairing_avoidance, "
    "scheduling_avoidance, division_flex, hotel, other. "
    "players is a list of {name, usta}. confidence is 0..1."
)

_SHOTS = """\
Example 1
Subject: Withdrawal Request: Maya Quintero
Body: Maya Quintero has requested to be withdrawn from singles.
{"intent":"withdrawal","players":[{"name":"Maya Quintero","usta":null}],"reason":"withdrawal request","confidence":0.9}

Example 2
Subject: Re: L3 Doubles
Body: Please pair Kai Hosch and Gabriel Zingman for doubles.
{"intent":"doubles","players":[{"name":"Kai Hosch","usta":null},{"name":"Gabriel Zingman","usta":null}],"reason":"named pairing","confidence":0.85}

Example 3
Subject: Thanks
Body: See you Saturday.
{"intent":"other","players":[],"reason":"acknowledgement","confidence":0.7}

Now extract:
Subject: {subject}
Body: {body}
"""

_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.S)
_JSON_OBJ = re.compile(r"\{.*\}", re.S)
_QUOTE_MARKERS = (
    "\n-----Original Message-----",
    "\n________________________________",
    "\nFrom:",
    "This email has been scanned for spam",
    "You are receiving this message as a registered tennis player",
)
_ON_WROTE = re.compile(r"\nOn .{5,120}? wrote:", re.I)


def llm_enabled() -> bool:
    return os.getenv("EMAIL_LLM", "").strip().lower() in {"1", "true", "yes", "on"}


def clip_email_text(subject: str | None, body: str | None, limit: int = 1200) -> tuple[str, str]:
    """Drop quoted threads / signatures and cap size before the model sees it."""
    subj = (subject or "").strip()[:200]
    text = body or ""
    cut = len(text)
    for mk in _QUOTE_MARKERS:
        i = text.find(mk)
        if i > 0:
            cut = min(cut, i)
    m = _ON_WROTE.search(text)
    if m and m.start() > 0:
        cut = min(cut, m.start())
    text = text[:cut].strip()
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0]
    return subj, text


def parse_llm_json(raw: str | None) -> dict | None:
    """Pull a JSON object from a model reply and coerce to our schema."""
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip()
    m = _FENCE.search(s)
    blob = m.group(1) if m else None
    if blob is None:
        m2 = _JSON_OBJ.search(s)
        blob = m2.group(0) if m2 else None
    if not blob:
        return None
    try:
        data = json.loads(blob)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    intent = str(data.get("intent") or "other").strip().lower().replace(" ", "_")
    if intent not in INTENTS:
        intent = "other"
    players = []
    for p in data.get("players") or []:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name") or "").strip()
        usta = p.get("usta") or p.get("usta_id") or p.get("usta_number")
        usta = str(usta).strip() if usta else None
        if name or usta:
            players.append({"name": name or None, "usta": usta})
    try:
        conf = float(data.get("confidence") if data.get("confidence") is not None else 0)
    except (TypeError, ValueError):
        conf = 0.0
    conf = max(0.0, min(1.0, conf))
    reason = data.get("reason")
    return {
        "intent": intent,
        "players": players,
        "reason": str(reason).strip() if reason else None,
        "confidence": conf,
    }


_DEV_COMPOSE_HOSTS = frozenset({"llm", "host.docker.internal"})


def _dev_env() -> bool:
    return os.getenv("ENV", "dev").strip().lower() in {
        "", "dev", "development", "local", "test", "ci",
    }


def llm_url_allowed(url: str, *, allow_remote: bool = False) -> bool:
    """True if EMAIL_LLM_BASE_URL is loopback or Fly-private (not the public net)."""
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    if host in {"127.0.0.1", "localhost", "::1"}:
        return True
    # Local docker-compose service names — only in ENV=dev (not a public TLD).
    if _dev_env() and host in _DEV_COMPOSE_HOSTS:
        return True
    # Fly org 6PN DNS — not routed on the public internet.
    if host.endswith(".internal") or host.endswith(".flycast"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return bool(allow_remote)
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    return bool(allow_remote)


def _assert_local_url(url: str) -> None:
    allow_remote = os.getenv("EMAIL_LLM_ALLOW_REMOTE", "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    if llm_url_allowed(url, allow_remote=allow_remote):
        return
    raise RuntimeError(
        "EMAIL_LLM_BASE_URL must be loopback or Fly private DNS "
        "(*.internal / *.flycast), not a public host. "
        "Set EMAIL_LLM_ALLOW_REMOTE=1 only after a D5 review."
    )


def llm_base_url() -> str:
    return os.getenv("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1").rstrip("/")


def llm_health_url(base: str | None = None) -> str:
    """llama-server ``GET /health`` (same host as EMAIL_LLM_BASE_URL, no /v1)."""
    u = (base or llm_base_url()).rstrip("/")
    if u.endswith("/v1"):
        u = u[:-3]
    return u.rstrip("/") + "/health"


def probe_llm(timeout: float = 1.5) -> str:
    """Sidecar status: ``off`` (flag down), ``ok`` (HTTP 2xx), or ``down``.

    Never raises. Does not send email text. Site health stays ``ok`` if this
    is ``down`` — leftover triage falls back to heuristics.
    """
    if not llm_enabled():
        return "off"
    try:
        _assert_local_url(llm_base_url())
    except RuntimeError:
        return "down"
    try:
        req = urllib.request.Request(llm_health_url(), method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if 200 <= getattr(resp, "status", 200) < 300:
                return "ok"
    except (urllib.error.URLError, TimeoutError, RuntimeError, OSError):
        return "down"
    return "down"


def _complete(prompt: str) -> str:
    """POST /chat/completions on the local llama.cpp server. Overridable in tests."""
    base = llm_base_url()
    _assert_local_url(base)
    timeout = float(os.getenv("EMAIL_LLM_TIMEOUT", "8"))
    max_tokens = int(os.getenv("EMAIL_LLM_MAX_TOKENS", "192"))
    model = os.getenv("EMAIL_LLM_MODEL", "qwen2.5-1.5b-instruct")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    headers = {"Content-Type": "application/json"}
    token = os.getenv("EMAIL_LLM_TOKEN", "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""


def extract_email(subject: str | None, body: str | None) -> dict | None:
    """Ask the local model. Returns None on disable / timeout / bad JSON."""
    if not llm_enabled():
        return None
    subj, clipped = clip_email_text(subject, body)
    # str.replace — the few-shot JSON uses {braces} that str.format would eat.
    prompt = _SHOTS.replace("{subject}", subj or "(none)").replace("{body}", clipped or "(empty)")
    try:
        raw = _complete(prompt)
    except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError, OSError):
        return None
    return parse_llm_json(raw)


def maybe_intent(subject: str | None, body: str | None, heuristic: str) -> str:
    """Hybrid: keep a confident heuristic; LLM only for leftover ``other``."""
    if heuristic and heuristic != "other":
        return heuristic
    if not llm_enabled():
        return heuristic or "other"
    parsed = extract_email(subject, body)
    if not parsed:
        return heuristic or "other"
    if parsed["confidence"] < 0.6:
        return heuristic or "other"
    if parsed["intent"] == "other":
        return heuristic or "other"
    return parsed["intent"]
