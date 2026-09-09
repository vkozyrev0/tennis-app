"""Outlook / Microsoft Graph mail feed: stored settings + latest-mail cursor.

App-only client-credentials token, then ``GET /users/{mailbox}/messages``
(Entra ``Mail.Read``, not ``Mail.ReadWrite``). Never DELETE/PATCH mailbox
messages. Clear inbox removes CourtOps copies only.
The client secret is Fernet-encrypted. GET never returns it — only ``has_secret``.
An unconfigured row is prefilled with the tennis-director tenant, client id,
and mailbox. The Entra client secret is entered in Setup and never stored in
source.
"""
from __future__ import annotations

import http.client
import json
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .crypto import decrypt as _dec
from .crypto import encrypt as _enc
from .email_ingest import IngestPayload, html_to_text, ingest_email, parse_received_at

_FEED_ID = 1
_DEFAULT_TENANT = "4c0cbcf5-4d26-4983-afdb-cc67e4754e4a"
_DEFAULT_CLIENT_ID = "api://1fdab846-8104-468e-a650-149c2ddc40c6"
_DEFAULT_MAILBOX = "TD@myadllc.com"
_DEFAULT_SECRET = ""
_DEFAULT_SECRET_EXPIRES = "9/7/2028"
_GRAPH_SCOPE = "https://graph.microsoft.com/.default"
_MAX_BATCH = 50
_MAX_WINDOW_BATCH = 200

HttpFn = Callable[..., Any]

_DEFAULTS = {
    "enabled": False,
    "tenant_id": _DEFAULT_TENANT,
    "client_id": _DEFAULT_CLIENT_ID,
    "mailbox": _DEFAULT_MAILBOX,
    "mail_query": None,
    "poll_minutes": 15,
    "lookback_days": 7,
    "tournament_id": None,
    "client_secret_expires": _DEFAULT_SECRET_EXPIRES,
    "last_received_at": None,
    "last_fetched_at": None,
    "last_status": None,
    "last_error": None,
    "last_imported": 0,
    "last_duplicates": 0,
}


def normalize_client_id(raw: str | None) -> str:
    """Entra v2 token endpoint wants the GUID, not an ``api://`` URI."""
    s = (raw or "").strip()
    if s.lower().startswith("api://"):
        s = s[6:].strip()
    return s


def _redact(text: str, secret: str | None = None) -> str:
    out = str(text or "")
    for s in (_DEFAULT_SECRET, secret):
        if not s:
            continue
        out = out.replace(s, "[redacted]")
        out = out.replace(urllib.parse.quote(s, safe=""), "[redacted]")
    return out


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _secret_plain(row: dict) -> str:
    stored = ""
    enc = row.get("secret_enc")
    if enc:
        stored = (_dec(enc) or "").strip()
    return stored or _DEFAULT_SECRET


def _email_address(node: Any) -> str | None:
    if not node:
        return None
    if isinstance(node, str):
        return node.strip() or None
    if not isinstance(node, dict):
        return None
    ea = node.get("emailAddress") or node
    if isinstance(ea, dict):
        addr = ea.get("address")
        return str(addr).strip() if addr else None
    return None


def graph_message_to_payload(msg: dict, *, tournament_id: int | None = None) -> IngestPayload:
    """Microsoft Graph message JSON → ingest payload. Used by fetch and tests."""
    mid = msg.get("internetMessageId") or msg.get("id")
    from_addr = _email_address(msg.get("from"))
    to_addrs: list[str] = []
    for rec in msg.get("toRecipients") or []:
        addr = _email_address(rec)
        if addr:
            to_addrs.append(addr)
    to_addr = ", ".join(to_addrs) or None
    body_obj = msg.get("body") if isinstance(msg.get("body"), dict) else {}
    content = (body_obj or {}).get("content") or msg.get("bodyPreview")
    ctype = str((body_obj or {}).get("contentType") or "").lower()
    if content and ctype == "html":
        content = html_to_text(str(content))
    elif content:
        content = str(content).strip() or None
    received = parse_received_at(msg.get("receivedDateTime"))
    return IngestPayload(
        message_id=str(mid).strip() if mid else None,
        from_address=from_addr,
        to_address=to_addr,
        subject=(str(msg["subject"]).strip() if msg.get("subject") else None),
        body=(content.strip() if isinstance(content, str) and content.strip() else None),
        tournament_id=tournament_id,
        received_at=received,
        ingest_source="outlook",
    )


def _has_stored_secret(row: dict | None) -> bool:
    """True only when a non-empty client secret is stored (not an empty default)."""
    if not row:
        return False
    enc = row.get("secret_enc")
    if not enc:
        return False
    plain = (_dec(enc) or "").strip()
    return bool(plain)


def public_row(row: dict | None) -> dict:
    """Client-safe settings: never include the encrypted secret."""
    src = dict(_DEFAULTS)
    if row:
        src.update({k: row.get(k, src.get(k)) for k in _DEFAULTS})
        src["has_secret"] = _has_stored_secret(row)
        src["updated_at"] = row.get("updated_at")
    else:
        src["has_secret"] = False
        src["updated_at"] = None
    for key in ("last_received_at", "last_fetched_at", "updated_at"):
        val = src.get(key)
        if hasattr(val, "isoformat"):
            src[key] = val.isoformat()
    return src


def load_feed(cur) -> dict:
    cur.execute("SELECT * FROM outlook_feed WHERE id = %s", (_FEED_ID,))
    row = cur.fetchone()
    if not row:
        cur.execute(
            "INSERT INTO outlook_feed (id) VALUES (%s) ON CONFLICT (id) DO NOTHING",
            (_FEED_ID,),
        )
        cur.execute("SELECT * FROM outlook_feed WHERE id = %s", (_FEED_ID,))
        row = cur.fetchone()
    return dict(row) if row else dict(_DEFAULTS)


def save_feed(cur, patch: dict) -> dict:
    """Upsert settings. Empty ``client_secret`` keeps the stored secret."""
    row = load_feed(cur)
    enabled = bool(patch.get("enabled", row.get("enabled")))
    tenant = patch.get("tenant_id", row.get("tenant_id"))
    tenant = str(tenant).strip() if tenant else (row.get("tenant_id") or _DEFAULT_TENANT)
    client_id = patch.get("client_id", row.get("client_id"))
    client_id = str(client_id).strip() if client_id else (row.get("client_id") or _DEFAULT_CLIENT_ID)
    mailbox = patch.get("mailbox", row.get("mailbox"))
    mailbox = str(mailbox).strip() if mailbox else (row.get("mailbox") or _DEFAULT_MAILBOX)
    query = patch.get("mail_query", row.get("mail_query"))
    query = str(query).strip() if query else None
    expires = patch.get("client_secret_expires", row.get("client_secret_expires"))
    expires = str(expires).strip() if expires else (row.get("client_secret_expires") or _DEFAULT_SECRET_EXPIRES)
    try:
        poll = max(1, min(24 * 60, int(patch.get("poll_minutes")
                   if patch.get("poll_minutes") is not None
                   else (row.get("poll_minutes") or 15))))
    except (TypeError, ValueError):
        poll = 15
    try:
        lookback = max(1, min(90, int(patch.get("lookback_days")
                        if patch.get("lookback_days") is not None
                        else (row.get("lookback_days") or 7))))
    except (TypeError, ValueError):
        lookback = 7
    tid = patch.get("tournament_id", row.get("tournament_id"))
    if tid in ("", None):
        tid = None
    else:
        try:
            tid = int(tid)
        except (TypeError, ValueError):
            tid = row.get("tournament_id")
    secret = row.get("secret_enc")
    pw = patch.get("client_secret")
    reset_cursor = False
    if pw is not None and str(pw).strip():
        secret = _enc(str(pw).strip())
        reset_cursor = True
    old_box = (row.get("mailbox") or "").strip().lower()
    if old_box and old_box != mailbox.lower():
        reset_cursor = True
    if reset_cursor:
        cur.execute(
            """
            UPDATE outlook_feed SET
                enabled = %s, tenant_id = %s, client_id = %s, secret_enc = %s,
                mailbox = %s, mail_query = %s, poll_minutes = %s, lookback_days = %s,
                tournament_id = %s, client_secret_expires = %s,
                last_received_at = NULL,
                last_status = NULL, last_error = NULL,
                updated_at = now()
            WHERE id = %s
            RETURNING *
            """,
            (enabled, tenant, client_id, secret, mailbox, query, poll, lookback,
             tid, expires, _FEED_ID),
        )
    else:
        cur.execute(
            """
            UPDATE outlook_feed SET
                enabled = %s, tenant_id = %s, client_id = %s, secret_enc = %s,
                mailbox = %s, mail_query = %s, poll_minutes = %s, lookback_days = %s,
                tournament_id = %s, client_secret_expires = %s,
                updated_at = now()
            WHERE id = %s
            RETURNING *
            """,
            (enabled, tenant, client_id, secret, mailbox, query, poll, lookback,
             tid, expires, _FEED_ID),
        )
    return dict(cur.fetchone())


def _connect_host(host: str, port: int, timeout: float):
    """Connect IPv4 first. Alpine/Docker often has AAAA records but no IPv6 route
    (Errno 101 Network unreachable) and default getaddrinfo can return only v6."""
    last_err: Exception | None = None
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            infos = socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)
        except OSError as e:
            last_err = e
            continue
        for fam, typ, proto, _, sockaddr in infos:
            sock = socket.socket(fam, typ, proto)
            sock.settimeout(timeout)
            try:
                sock.connect(sockaddr)
                return sock
            except OSError as e:
                last_err = e
                try:
                    sock.close()
                except OSError:
                    pass
    raise OSError(last_err or f"could not connect to {host}:{port}")


class _HTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        sock = _connect_host(self.host, self.port or 443, self.timeout if self.timeout is not None else 30)
        context = self._context or ssl.create_default_context()
        self.sock = context.wrap_socket(sock, server_hostname=self.host)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_HTTPSConnection, req)


def _urlopen(req, timeout=30):
    opener = urllib.request.build_opener(_HTTPSHandler())
    return opener.open(req, timeout=timeout)


def _http_json(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    data: bytes | None = None,
    timeout: float = 30,
) -> tuple[int, Any]:
    """POST/GET JSON. Raises RuntimeError on 4xx, OSError on network/5xx."""
    req = urllib.request.Request(url, data=data, method=method.upper())
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with _urlopen(req, timeout=timeout) as resp:  # noqa: S310
            raw = resp.read() or b""
            status = getattr(resp, "status", None) or getattr(resp, "code", 200) or 200
    except urllib.error.HTTPError as e:
        try:
            raw = e.read() or b""
        except Exception:
            raw = b""
        status = int(e.code)
        text = _redact(raw.decode("utf-8", errors="replace")[:500])
        if status >= 500:
            raise OSError(f"Microsoft HTTP {status}: {text}") from e
        raise RuntimeError(f"Microsoft HTTP {status}: {text}") from e
    except urllib.error.URLError as e:
        raise OSError(f"Microsoft request failed: {e.reason}") from e
    except TimeoutError as e:
        raise OSError("Microsoft request timed out") from e
    if status >= 400:
        text = _redact(raw.decode("utf-8", errors="replace")[:500])
        if status >= 500:
            raise OSError(f"Microsoft HTTP {status}: {text}")
        raise RuntimeError(f"Microsoft HTTP {status}: {text}")
    if not raw:
        return int(status), {}
    try:
        return int(status), json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        raise RuntimeError("Microsoft returned non-JSON") from e


def _call_http(http: HttpFn, method: str, url: str, *, secret: str | None = None, **kw) -> Any:
    result = http(method, url, **kw)
    if isinstance(result, tuple) and len(result) == 2:
        status, payload = result
        if status >= 400:
            text = _redact(str(payload)[:500], secret)
            if status >= 500:
                raise OSError(f"Microsoft HTTP {status}: {text}")
            raise RuntimeError(f"Microsoft HTTP {status}: {text}")
        return payload
    return result


def _since_cutoff(row: dict) -> tuple[datetime, bool]:
    """Return (cutoff, exclusive). Exclusive True means later-fetch (gt cursor)."""
    last = row.get("last_received_at")
    if last:
        if not isinstance(last, datetime):
            last = parse_received_at(last)
        if isinstance(last, datetime):
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            return last, True
    days = int(row.get("lookback_days") or 7)
    return datetime.now(timezone.utc) - timedelta(days=days), False


def _keep_message(msg: dict, cutoff: datetime, exclusive: bool) -> bool:
    dt = parse_received_at(msg.get("receivedDateTime"))
    if dt is None:
        return not exclusive
    if exclusive:
        return dt > cutoff
    return dt >= cutoff


def _graph_fetch(
    row: dict,
    *,
    http: HttpFn,
    since: datetime | None = None,
    until: datetime | None = None,
) -> tuple[list[dict], datetime | None]:
    mailbox = (row.get("mailbox") or "").strip()
    if not mailbox:
        raise RuntimeError("Mailbox is required")
    tenant = (row.get("tenant_id") or "").strip()
    if not tenant:
        raise RuntimeError("Directory (tenant) ID is required")
    client_id = normalize_client_id(row.get("client_id"))
    if not client_id:
        raise RuntimeError("Application (client) ID is required")
    secret = _secret_plain(row)
    token_url = (
        f"https://login.microsoftonline.com/{urllib.parse.quote(tenant, safe='')}"
        f"/oauth2/v2.0/token"
    )
    token_body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": secret,
        "scope": _GRAPH_SCOPE,
    }).encode()
    token_payload = _call_http(
        http, "POST", token_url,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=token_body,
        secret=secret,
    )
    if not isinstance(token_payload, dict) or not token_payload.get("access_token"):
        raise RuntimeError("Microsoft token response missing access_token")
    token = token_payload["access_token"]
    date_window = since is not None or until is not None
    if date_window:
        cutoff = since or (datetime.now(timezone.utc) - timedelta(days=90))
        exclusive = False
        until_dt = until
    else:
        cutoff, exclusive = _since_cutoff(row)
        until_dt = None
    cap = _MAX_WINDOW_BATCH if date_window else _MAX_BATCH
    params: dict[str, str] = {
        "$top": str(min(_MAX_BATCH, cap)),
        "$select": "internetMessageId,from,toRecipients,subject,body,bodyPreview,receivedDateTime,isRead",
    }
    query = (row.get("mail_query") or "").strip()
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Prefer": 'outlook.body-content-type="text"',
    }
    if query and not date_window:
        # Graph rejects $search combined with $orderby (and $filter).
        params["$search"] = f'"{query}"'
        headers["ConsistencyLevel"] = "eventual"
    else:
        params["$orderby"] = "receivedDateTime asc"
        if date_window:
            parts = [f"receivedDateTime ge {_iso(cutoff)}"]
            if until_dt is not None:
                parts.append(f"receivedDateTime le {_iso(until_dt)}")
            params["$filter"] = " and ".join(parts)
        else:
            op = "gt" if exclusive else "ge"
            params["$filter"] = f"receivedDateTime {op} {_iso(cutoff)}"
    user = urllib.parse.quote(mailbox, safe="@")
    mail_url = (
        f"https://graph.microsoft.com/v1.0/users/{user}/messages?"
        + urllib.parse.urlencode(params)
    )
    mail_payload = _call_http(http, "GET", mail_url, headers=headers, secret=secret)
    if not isinstance(mail_payload, dict):
        raise RuntimeError("Microsoft Graph returned unexpected payload")
    raw_msgs: list = []
    while True:
        chunk = mail_payload.get("value") or []
        if isinstance(chunk, list):
            raw_msgs.extend(chunk)
        nxt = mail_payload.get("@odata.nextLink") if date_window else None
        if not nxt or not isinstance(nxt, str) or len(raw_msgs) >= cap:
            break
        mail_payload = _call_http(http, "GET", nxt, headers=headers, secret=secret)
        if not isinstance(mail_payload, dict):
            break
    kept: list[dict] = []
    for item in raw_msgs:
        if not isinstance(item, dict):
            continue
        if date_window:
            dt = parse_received_at(item.get("receivedDateTime"))
            if dt is None:
                kept.append(item)
                continue
            if dt < cutoff:
                continue
            if until_dt is not None and dt > until_dt:
                continue
            kept.append(item)
        elif _keep_message(item, cutoff, exclusive):
            kept.append(item)
    kept.sort(key=lambda m: parse_received_at(m.get("receivedDateTime")) or datetime.min.replace(tzinfo=timezone.utc))
    kept = kept[:cap]
    stored_cursor = row.get("last_received_at")
    if stored_cursor and not isinstance(stored_cursor, datetime):
        stored_cursor = parse_received_at(stored_cursor)
    new_cursor = stored_cursor if date_window else (cutoff if exclusive else None)
    for item in kept:
        dt = parse_received_at(item.get("receivedDateTime"))
        if dt is None:
            continue
        if new_cursor is None or dt > new_cursor:
            new_cursor = dt
    return kept, new_cursor


def fetch_latest(cur, *, http: HttpFn | None = None,
                 since: datetime | None = None, until: datetime | None = None,
                 tournament_id: int | None = None) -> dict:
    """Pull new Graph messages and ingest them. Updates the receivedDateTime cursor."""
    row = load_feed(cur)
    if not row.get("enabled"):
        raise RuntimeError("Outlook feed is disabled — enable it on Inbox → Outlook")
    http_fn = http or _http_json
    try:
        messages, new_cursor = _graph_fetch(
            row, http=http_fn, since=since, until=until,
        )
    except Exception as exc:
        secret = _secret_plain(row)
        msg = _redact(str(exc)[:500], secret)
        cur.execute(
            """
            UPDATE outlook_feed SET last_fetched_at = now(), last_status = 'error',
                   last_error = %s WHERE id = %s
            """,
            (msg, _FEED_ID),
        )
        if isinstance(exc, OSError):
            raise OSError(msg) from exc
        raise RuntimeError(msg) from exc
    imported = 0
    dupes = 0
    errors: list[str] = []
    tid = tournament_id if tournament_id is not None else row.get("tournament_id")
    for item in messages:
        try:
            payload = graph_message_to_payload(item, tournament_id=tid)
            result = ingest_email(cur, payload, auto_classify=True)
            if result.get("duplicate"):
                dupes += 1
            else:
                imported += 1
        except Exception as exc:
            errors.append(_redact(str(exc)[:200]))
    status = "ok" if not errors else "partial"
    err = "; ".join(errors[:3]) if errors else None
    cur.execute(
        """
        UPDATE outlook_feed SET
            last_received_at = %s, last_fetched_at = now(),
            last_status = %s, last_error = %s,
            last_imported = %s, last_duplicates = %s
        WHERE id = %s
        RETURNING *
        """,
        (new_cursor, status, err, imported, dupes, _FEED_ID),
    )
    out = public_row(dict(cur.fetchone()))
    out["fetched"] = len(messages)
    out["imported"] = imported
    out["duplicates"] = dupes
    return out
