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

# One shared leftover prompt for every email (not a per-message template).
# Few-shots use invented names so the model learns the rule, not the corpus.
_SYSTEM = (
    "You classify leftover USTA junior/adult tournament emails. "
    "Reply with JSON only, no markdown. "
    "intent must be one of: withdrawal, doubles, late_entry, pairing_avoidance, "
    "scheduling_avoidance, division_flex, hotel, other. "
    "players is a list of {name, usta}. confidence is 0..1. "
    "Classify the LATEST body only (ignore Re:/FW:/**EXTERNAL** and quotes). "
    "Cancel / cancellation of singles or doubles is withdrawal (same as "
    "withdraw / WITHDRAWAL REQUEST). "
    "A request to still enter or add a player in singles is late_entry. "
    "A request to add/enter doubles or name a doubles partner is doubles. "
    "pairing_avoidance only if they ask two players not to play each other. "
    "Rules, in order: "
    "(1) Latest body is a short ack (Thanks / Thank you / Thank you for "
    "confirming / Will do / Sure / Yes I did / We will pair them / No worries) "
    "OR asks someone to email / confirm they are good → other, even if the "
    "subject says withdraw, cancel, doubles, singles, confirmation, or pairing. "
    "(2) Else two people named as partners / would like to be partners / "
    "will partner → doubles (a trailing Thank you does not cancel that). "
    "(3) Else withdraw / cancel / WITHDRAWAL REQUEST / requested to be "
    "withdrawn from singles and/or doubles → withdrawal. "
    "(4) Else missed the deadline / still enter / add NAME in singles → "
    "late_entry. "
    "(5) Else subject contains Doubles Confirmation and the latest body "
    "confirms a pair (not only a C: address or Thank you) → doubles. "
    "(6) Else add NAME for doubles / find a partner → doubles. "
    "(7) Else other. "
    "Set intent to match the rule. Do not set intent from the subject alone "
    "when the body is an ack. "
    "If reason is acknowledgement or waiting on email, intent is other "
    "unless the body lists two people as doubles partners."
)

_SHOTS = """\
Example 1
Subject: WITHDRAWAL REQUEST: Jane Roe, Girls' 16 & under singles
Body: Jane Roe has requested to be withdrawn from singles.
{"intent":"withdrawal","reason":"cancel/withdraw singles","players":[{"name":"Jane Roe","usta":null}],"confidence":0.9}

Example 2
Subject: Please cancel doubles
Body: Please cancel Jane Roe from doubles.
{"intent":"withdrawal","reason":"cancel/withdraw doubles","players":[{"name":"Jane Roe","usta":null}],"confidence":0.9}

Example 3
Subject: Doubles partners
Body: Alex Kim and Sam Lee Doubles partners Thank you
{"intent":"doubles","reason":"named pairing","players":[{"name":"Alex Kim","usta":null},{"name":"Sam Lee","usta":null}],"confidence":0.9}

Example 3b
Subject: Partner request
Body: Alex Kim and Sam Lee would like to be doubles partners. Please put them together.
{"intent":"doubles","reason":"named pairing","players":[{"name":"Alex Kim","usta":null},{"name":"Sam Lee","usta":null}],"confidence":0.9}

Example 3c
Subject: Re: Event Doubles
Body: Good morning,
Alex Kim and Sam Lee
Doubles partners
Thank you
Pat
{"intent":"doubles","reason":"named pairing","players":[{"name":"Alex Kim","usta":null},{"name":"Sam Lee","usta":null}],"confidence":0.9}

Example 4
Subject: Re: Boys 16s Doubles Confirmation-Level 4 Open
Body: Please confirm Alex Kim for doubles.
{"intent":"doubles","reason":"doubles confirmation","players":[{"name":"Alex Kim","usta":null}],"confidence":0.8}

Example 5
Subject: Missed deadline
Body: Can we still enter Jordan Blake in singles?
{"intent":"late_entry","reason":"singles entry request","players":[{"name":"Jordan Blake","usta":null}],"confidence":0.8}

Example 6
Subject: Jordan Blake
Body: Can you add Jordan for doubles if it is not too late. We will try to find a partner.
{"intent":"doubles","reason":"add for doubles","players":[{"name":"Jordan Blake","usta":null}],"confidence":0.8}

Example 7
Subject: Re: Withdrawal Request
Body: Thank you
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 8
Subject: Re: Jordan Blake doubles pairing change
Body: Will do
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 9
Subject: Re: Casey Ng - Doubles partner
Body: We will pair them.
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 10
Subject: Re: Pairing
Body: Please ask the partner to email to confirm.
{"intent":"other","reason":"waiting on partner email","players":[],"confidence":0.85}

Example 10b
Subject: Re: Question
Body: Please ask his parent to email me. Thanks!!
{"intent":"other","reason":"waiting on parent email","players":[],"confidence":0.85}

Example 10c
Subject: Re: Event pairing
Body: Please ask her partner to email also to confirm, if not sent already.
{"intent":"other","reason":"waiting on partner email","players":[],"confidence":0.85}

Example 10d
Subject: Re: Doubles pairing request
Body: Please ask the partner to also email if they have not already.
{"intent":"other","reason":"waiting on partner email","players":[],"confidence":0.85}

Example 11
Subject: Re: Withdrawal
Body: Thanks.
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 12
Subject: Re: Event
Body: Yes, I did.
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 13
Subject: Re: Partnership
Body: Sure.
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 14
Subject: Re: Partners
Body: please confirm they are good to go. Thanks!
{"intent":"other","reason":"waiting on confirm","players":[],"confidence":0.85}

Example 15
Subject: Re: Boys doubles - Roe / Kim
Body: C: Jane Roe
Thank you!
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 16
Subject: Re: Doubles Confirmation thread
Body: C: dad@gmail.com
{"intent":"other","reason":"cc only","players":[],"confidence":0.9}

Example 17
Subject: Re: girls doubles partner
Body: Please ask Alex to email us to verify.
{"intent":"other","reason":"waiting on partner email","players":[],"confidence":0.85}

If the body is only an ack or asking someone to email, intent is other.
The body "We will pair them." is other (it is an ack, not a new pairing).
A body that is only a C: address is other.
Will do as the whole Body is other, not named pairing, even when Subject says doubles pairing change.
will partner with two named players is doubles, not an ack.
Now extract. Read Body first; if it is an ack, intent is other even when Subject says withdraw or doubles.
Body: {body}
Subject: {subject}
"""

_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.S)
_JSON_OBJ = re.compile(r"\{.*\}", re.S)
_QUOTE_MARKERS = (
    "\n-----Original Message-----",
    "\n________________________________",
    "\nFrom:",
    "This email has been scanned for spam",
    "You are receiving this message as a registered tennis player",
    "\nGet Outlook for iOS",
    "\nSent from my iPhone",
)
_ON_WROTE = (
    re.compile(r"\nOn .{5,120}? wrote:", re.I),
    re.compile(r"\nOn .{10,200}? wrote:", re.I | re.S),
)


def llm_enabled() -> bool:
    return os.getenv("EMAIL_LLM", "").strip().lower() in {"1", "true", "yes", "on"}


_PDF_DATE = re.compile(r"^\[Date:[^\]]*\]\s*", re.M)
_PDF_TO = re.compile(r"^\[To:[^\]]*\]\s*", re.M)


def clip_email_text(subject: str | None, body: str | None, limit: int = 1200) -> tuple[str, str]:
    """Drop quoted threads / signatures and cap size before the model sees it."""
    subj = (subject or "").strip()[:200]
    text = body or ""
    cut = len(text)
    for mk in _QUOTE_MARKERS:
        i = text.find(mk)
        if i > 0:
            cut = min(cut, i)
    for _on in _ON_WROTE:
        m = _on.search(text)
        if m and m.start() > 0:
            cut = min(cut, m.start())
    text = text[:cut].strip()
    # Inbox PDF rows prepend [Date]/[To] wrappers; they are not the ask.
    text = _PDF_DATE.sub("", text, count=1)
    text = _PDF_TO.sub("", text, count=1)
    text = text.strip()
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


def leftover_prompt(subject: str | None, body: str | None) -> str:
    """Few-shot user prompt for leftover classify. str.replace so JSON braces survive."""
    return (
        _SHOTS
        .replace("{subject}", subject or "(none)")
        .replace("{body}", body or "(empty)")
    )


def leftover_model_intent(subject: str | None, body: str | None) -> dict | None:
    """Clip + shared leftover_prompt + sidecar + parse_llm_json. No intent rewrite."""
    if not llm_enabled():
        return None
    subj, clipped = clip_email_text(subject, body)
    prompt = leftover_prompt(subj, clipped)
    try:
        raw = _complete(prompt)
    except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError, OSError):
        return None
    return parse_llm_json(raw)


def extract_email(subject: str | None, body: str | None) -> dict | None:
    """Ask the local model. Returns None on disable / timeout / bad JSON."""
    return leftover_model_intent(subject, body)


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
