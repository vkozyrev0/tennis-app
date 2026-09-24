"""Optional small-LLM assist for leftover inbox emails (D5).

Heuristic triage in ``triage.classify`` stays the default. When ``EMAIL_LLM=1``
and the heuristic returns ``other``, this module asks an OpenAI-compatible
endpoint for a JSON intent.

Default provider: the **DeepSeek API** (``https://api.deepseek.com/v1``, model
``deepseek-flash``), key from ``DEEPSEEK_API_KEY`` — see ``llm_api_key``.

PII: leftover email text (junior names, USTA numbers) leaves this machine on
that path. It is the same text the TD already forwards by email, but it is no
longer on-box — see docs/email-llm-prompt.md and docs/coppa-policy.md.

Other allowed destinations (set ``EMAIL_LLM_BASE_URL``):
  * loopback / a private IP — the optional local llama.cpp sidecar
  * Fly 6PN: ``*.internal``, ``*.flycast``, unique-local IPv6 (``fd00::/8``)
Any *other* public host (``*.fly.dev``, ``api.x.ai``, …) needs
``EMAIL_LLM_ALLOW_REMOTE=1``.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import urlparse

INTENTS = frozenset({
    "withdrawal", "doubles", "late_entry", "pairing_avoidance",
    "scheduling_avoidance", "division_flex", "hotel", "other",
})

# Small-LLM provider. ``GET https://api.deepseek.com/v1/models`` lists
# deepseek-flash and deepseek-v4-pro; ``deepseek-chat`` is accepted as an alias.
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DEEPSEEK_HOST = "api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-flash"
# The optional local llama.cpp sidecar (see fly.llm.toml).
LOCAL_BASE_URL = "http://127.0.0.1:8080/v1"
SIDECAR_MODEL = "qwen2.5-1.5b-instruct"
DEEPSEEK_KEY_ENV = "DEEPSEEK_API_KEY"

# EMAIL_LLM_PROVIDER selects the default endpoint; EMAIL_LLM_BASE_URL still
# overrides it outright. DeepSeek is the default.
PROVIDER_ENV = "EMAIL_LLM_PROVIDER"
DEEPSEEK_PROVIDER = "deepseek"
LOCAL_PROVIDER = "local"
_LOCAL_ALIASES = frozenset({"local", "sidecar", "llama", "llamacpp", "onbox", "on-box"})

# One shared leftover prompt for every email (not a per-message template).
# Few-shots use invented names so the model learns the rule, not the corpus.
_SYSTEM = (
    "You classify leftover USTA junior/adult tournament emails. "
    "Reply with JSON only, no markdown. "
    "intent must be one of: withdrawal, doubles, late_entry, pairing_avoidance, "
    "scheduling_avoidance, division_flex, hotel, other. "
    "Treat those intents equally; do not prefer doubles over withdrawal, "
    "late_entry (singles entry), or other. "
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
    "will partner / pair two named players for doubles → doubles "
    "(a trailing Thank you does not cancel that; still doubles if the body "
    "mentions someone else's partner is withdrawing). "
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
    "unless the body lists two people as doubles partners. "
    "After intent, fill players for that intent: players[0] first named "
    "player {name, usta}, players[1] only if a second player is named "
    "(doubles partner). usta is digits or null if not stated. His/Her "
    "USTA # is N after a name belongs to that player. Skip parent, "
    "sign-off, and a partner only said to be withdrawing. other → []."
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


# How much model work one synchronous request may do. Each model call costs up
# to EMAIL_LLM_TIMEOUT seconds, so a pass over N stored copies used to run for
# N round trips inside one HTTP request (200 copies x 8s = ~27 minutes with a
# slow endpoint, which reads as a hang in the overlay). A pass now stops at the
# budget and reports what it left behind.
DEFAULT_PASS_MAX_CALLS = 20
DEFAULT_PASS_SECONDS = 20.0


class PassBudget:
    """Bound on the model work a single synchronous pass may do.

    Pure (no I/O, injectable clock) so the policy is unit-testable without a
    mailbox or a model: ``allow()`` says whether one more call fits, ``spend()``
    records one, and ``as_dict()`` reports the bound to the caller.
    """

    def __init__(self, *, max_calls: int | None = None, seconds: float | None = None,
                 clock=time.monotonic) -> None:
        raw_calls = max_calls if max_calls is not None else os.getenv("EMAIL_LLM_MAX_CALLS")
        raw_secs = seconds if seconds is not None else os.getenv("EMAIL_LLM_PASS_SECONDS")
        try:
            self.max_calls = max(0, int(raw_calls)) if raw_calls is not None else DEFAULT_PASS_MAX_CALLS
        except (TypeError, ValueError):
            self.max_calls = DEFAULT_PASS_MAX_CALLS
        try:
            self.seconds = max(0.0, float(raw_secs)) if raw_secs is not None else DEFAULT_PASS_SECONDS
        except (TypeError, ValueError):
            self.seconds = DEFAULT_PASS_SECONDS
        self._clock = clock
        self._start = clock()
        self.calls = 0
        self.denied = 0

    def elapsed(self) -> float:
        return self._clock() - self._start

    def allow(self) -> bool:
        """True while another model call fits inside both bounds."""
        if self.calls >= self.max_calls:
            return False
        return self.elapsed() < self.seconds

    def spend(self) -> None:
        self.calls += 1

    def deny(self) -> None:
        """Record a model call that the budget refused (heuristic-only copy)."""
        self.denied += 1

    def as_dict(self) -> dict:
        return {
            "max_calls": self.max_calls,
            "seconds": self.seconds,
            "calls": self.calls,
            "denied": self.denied,
            "elapsed_ms": int(self.elapsed() * 1000),
        }


def llm_enabled() -> bool:
    return os.getenv("EMAIL_LLM", "").strip().lower() in {"1", "true", "yes", "on"}


# The budget of the pass currently running in this request/thread. Set by
# `pass_budget()` around a download-then-parse pass so every model call made
# underneath (ingest-time classify, the reprocess loop) shares one bound
# without threading a parameter through ingest_email/triage.
_ACTIVE_BUDGET: ContextVar["PassBudget | None"] = ContextVar("llm_pass_budget", default=None)


@contextmanager
def pass_budget(*, max_calls: int | None = None, seconds: float | None = None):
    """Bound the model calls made inside this block.

    Yields the :class:`PassBudget` so the caller can report what it spent and
    what it left behind. Nested blocks each get their own bound.
    """
    budget = PassBudget(max_calls=max_calls, seconds=seconds)
    token = _ACTIVE_BUDGET.set(budget)
    try:
        yield budget
    finally:
        _ACTIVE_BUDGET.reset(token)


def active_budget() -> "PassBudget | None":
    return _ACTIVE_BUDGET.get()


def budget_allows() -> bool:
    """True when this pass may spend another model call (no budget = yes)."""
    budget = _ACTIVE_BUDGET.get()
    if budget is None:
        return True
    if budget.allow():
        return True
    budget.deny()
    return False


def budget_spend() -> None:
    budget = _ACTIVE_BUDGET.get()
    if budget is not None:
        budget.spend()


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
    raw_players = data.get("players")
    if not isinstance(raw_players, list) or not raw_players:
        raw_players = []
        for key in ("player1", "player2", "first_player", "second_player"):
            p = data.get(key)
            if isinstance(p, dict):
                raw_players.append(p)
    players = []
    for p in raw_players:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name") or "").strip()
        usta = p.get("usta") or p.get("usta_id") or p.get("usta_number")
        usta = str(usta).strip() if usta else None
        if usta in {"null", "none", "n/a", ""}:
            usta = None
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

# Hosts we ship support for, allowed without the remote opt-in.
_ALLOWED_API_HOSTS = frozenset({DEEPSEEK_HOST})

# Local convenience only — a deployed box cannot read a user's home directory,
# so production must supply DEEPSEEK_API_KEY through its own secret store.
_GROK_CONFIG = os.path.join(os.path.expanduser("~"), ".grok", "config.toml")


def _dev_env() -> bool:
    return os.getenv("ENV", "dev").strip().lower() in {
        "", "dev", "development", "local", "test", "ci",
    }


def llm_url_allowed(url: str, *, allow_remote: bool = False) -> bool:
    """True if the endpoint is the configured provider, loopback, or Fly-private."""
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    # The small-LLM provider this app ships support for (DeepSeek). Any OTHER
    # public host still needs the explicit EMAIL_LLM_ALLOW_REMOTE opt-in.
    if host in _ALLOWED_API_HOSTS:
        return True
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
        "EMAIL_LLM_BASE_URL must be the DeepSeek API, loopback, or Fly private "
        "DNS (*.internal / *.flycast), not another public host. "
        "Set EMAIL_LLM_ALLOW_REMOTE=1 only after a D5 review."
    )


def llm_provider() -> str:
    """Which small-LLM backend the defaults point at:
    ``deepseek`` (the API, default) or ``local`` (the llama.cpp sidecar).

    Reads ``EMAIL_LLM_PROVIDER``; the local aliases are ``local``, ``sidecar``,
    ``llama``, ``llamacpp``, ``onbox``. Anything else — including an unset or
    mistyped value — keeps the documented default, DeepSeek.
    """
    value = os.getenv(PROVIDER_ENV, "").strip().lower()
    return LOCAL_PROVIDER if value in _LOCAL_ALIASES else DEEPSEEK_PROVIDER


def llm_base_url() -> str:
    """Configured endpoint: ``EMAIL_LLM_BASE_URL`` when set (the local sidecar,
    a Fly-private sidecar, …), otherwise the provider default — the DeepSeek API
    unless ``EMAIL_LLM_PROVIDER=local``."""
    explicit = os.getenv("EMAIL_LLM_BASE_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    return LOCAL_BASE_URL if llm_provider() == LOCAL_PROVIDER else DEEPSEEK_BASE_URL


def is_deepseek_url(url: str) -> bool:
    """True when the endpoint is the DeepSeek API (not the local sidecar)."""
    return (urlparse(url).hostname or "").lower() == DEEPSEEK_HOST


def llm_model(base: str | None = None) -> str:
    """EMAIL_LLM_MODEL wins; otherwise the provider's own default id."""
    explicit = os.getenv("EMAIL_LLM_MODEL", "").strip()
    if explicit:
        return explicit
    return DEEPSEEK_MODEL if is_deepseek_url(base or llm_base_url()) else SIDECAR_MODEL


def _grok_config_key(env_name: str) -> str:
    """The Grok config's DeepSeek block names the variable that holds the key
    (``env_key = "DEEPSEEK_API_KEY"``) and may carry the value itself. Read it
    as a local fallback; return "" when the file or the entry is absent."""
    try:
        import tomllib
        with open(os.getenv("GROK_CONFIG", _GROK_CONFIG), "rb") as fh:
            cfg = tomllib.load(fh)
    except (OSError, ValueError):
        return ""
    blocks = cfg.get("model")
    if not isinstance(blocks, dict):
        return ""
    for block in blocks.values():
        if not isinstance(block, dict):
            continue
        host = (urlparse(str(block.get("base_url") or "")).hostname or "").lower()
        if str(block.get("env_key") or "").strip() != env_name and host != DEEPSEEK_HOST:
            continue
        value = str(block.get("api_key") or "").strip()
        if value:
            return value
        return os.getenv(str(block.get("env_key") or env_name).strip(), "").strip()
    return ""


def llm_api_key(base: str | None = None) -> str:
    """Bearer token for the configured endpoint.

    DeepSeek: ``DEEPSEEK_API_KEY``, then the Grok config's declaration. The
    sidecar (or any other endpoint): ``EMAIL_LLM_TOKEN``. The credential is
    never crossed over — the sidecar's token is not sent to the public API.
    The value is never logged, echoed in an error, or returned by an API.
    """
    base = base or llm_base_url()
    if not is_deepseek_url(base):
        return os.getenv("EMAIL_LLM_TOKEN", "").strip()
    return os.getenv(DEEPSEEK_KEY_ENV, "").strip() or _grok_config_key(DEEPSEEK_KEY_ENV)


def llm_health_url(base: str | None = None) -> str:
    """A URL the configured endpoint really answers: the OpenAI-compatible
    ``GET /models`` for DeepSeek (it serves no ``/health``), llama-server's
    ``GET /health`` for the sidecar (same host, no ``/v1``)."""
    u = (base or llm_base_url()).rstrip("/")
    if is_deepseek_url(u):
        return u + "/models"
    if u.endswith("/v1"):
        u = u[:-3]
    return u.rstrip("/") + "/health"


def probe_llm(timeout: float = 1.5) -> str:
    """Endpoint status: ``off`` (flag down), ``ok`` (HTTP 2xx), or ``down``.

    Never raises, never sends email text, never reports the key. A provider that
    needs a key reports ``down`` without making a request when none is
    configured. Site health stays ``ok`` if this is ``down`` — leftover triage
    falls back to heuristics.
    """
    if not llm_enabled():
        return "off"
    base = llm_base_url()
    try:
        _assert_local_url(base)
    except RuntimeError:
        return "down"
    token = llm_api_key(base)
    if is_deepseek_url(base) and not token:
        return "down"          # inert: no key, so no request
    headers = {"Authorization": "Bearer " + token} if token else {}
    try:
        req = urllib.request.Request(llm_health_url(base), headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if 200 <= getattr(resp, "status", 200) < 300:
                return "ok"
    except (urllib.error.URLError, TimeoutError, RuntimeError, OSError):
        return "down"
    return "down"


def _post_chat(
    messages: list[dict],
    *,
    timeout: float,
    max_tokens: int,
    base: str | None = None,
    model: str | None = None,
) -> str:
    """POST an OpenAI-compatible ``/chat/completions``; return the first
    choice's content. THE single transport for both the leftover classifier
    (``_complete``) and the TD-chat planner (``td_chat.chat_complete``), so both
    reach whatever ``EMAIL_LLM_BASE_URL`` points at — DeepSeek by default.
    The key travels only in the Authorization header."""
    base = (base or llm_base_url()).rstrip("/")
    _assert_local_url(base)
    payload = {
        "model": model or llm_model(base),
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    headers = {"Content-Type": "application/json"}
    token = llm_api_key(base)
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


def _complete(prompt: str) -> str:
    """Leftover classifier: one shared system prompt + the clipped email.
    Overridable in tests."""
    return _post_chat(
        [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": prompt},
        ],
        timeout=float(os.getenv("EMAIL_LLM_TIMEOUT", "8")),
        max_tokens=int(os.getenv("EMAIL_LLM_MAX_TOKENS", "192")),
    )


def leftover_prompt(subject: str | None, body: str | None) -> str:
    """Few-shot user prompt for leftover classify. str.replace so JSON braces survive."""
    return (
        _SHOTS
        .replace("{subject}", subject or "(none)")
        .replace("{body}", body or "(empty)")
    )


# Last leftover parse for this process — classify() then suggest() can share it.
_LEFTOVER_LAST: tuple | None = None


def leftover_model_intent(
    subject: str | None, body: str | None, *, bypass_cache: bool = False,
) -> dict | None:
    """Clip + shared leftover_prompt + sidecar + parse_llm_json. No intent rewrite.

    ``bypass_cache`` (date-range reprocess after a leftover-prompt change)
    always hits the sidecar even if this process already parsed the same clip.
    """
    global _LEFTOVER_LAST
    if not llm_enabled():
        return None
    subj, clipped = clip_email_text(subject, body)
    key = (subj, clipped)
    if not bypass_cache and _LEFTOVER_LAST and _LEFTOVER_LAST[0] == key:
        return _LEFTOVER_LAST[1]
    # A pass that has spent its budget classifies this copy with the heuristic
    # only. The cache is left untouched so a later pass still gets a real answer.
    if not budget_allows():
        return None
    prompt = leftover_prompt(subj, clipped)
    try:
        raw = _complete(prompt)
    except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError, OSError):
        _LEFTOVER_LAST = (key, None)
        return None
    budget_spend()
    parsed = parse_llm_json(raw)
    _LEFTOVER_LAST = (key, parsed)
    return parsed


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
