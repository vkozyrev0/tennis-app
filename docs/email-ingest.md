# Email auto-ingest (D4)

Dedicated tournament addresses can forward into the **review inbox** without
manual paste. Classification is still the local keyword suggester (no LLM);
a human files each message into structured lists.

## Enable

Set a shared secret on the server:

```bash
# strong random secret — treat like a password
export INGEST_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"

# optional: land unrouted mail on one tournament
export INGEST_DEFAULT_TOURNAMENT_ID=12
```

Restart the API. Check:

```bash
curl -s http://localhost:8000/api/ingest/status
# {"enabled": true, "default_tournament_id": 12, ...}
```

When `INGEST_TOKEN` is unset, `POST /api/ingest/email` returns **503**.

## Route mail to a tournament

1. In **Setup → Tournaments**, set **Ingest address** to a local-part or full
   address, e.g. `macon2026` or `macon2026@inbox.example.com`.
2. Point your provider so the public address delivers to the webhook (below).
3. Inbound `To:` is matched case-insensitively against that field (full address
   or local-part). First match wins.

Priority for `tournament_id`:

1. Explicit `tournament_id` in the payload  
2. Match on `to_address` ↔ `tournament.ingest_address`  
3. `INGEST_DEFAULT_TOURNAMENT_ID`  
4. Otherwise the email still lands with `tournament_id = null` (unscoped inbox)

## Endpoints

| Method | Path | Body |
|--------|------|------|
| `POST` | `/api/ingest/email` | JSON (preferred) |
| `POST` | `/api/ingest/email/form` | `multipart/form-data` or urlencoded (Mailgun / SendGrid-style fields) |
| `GET`  | `/api/ingest/status` | — (no auth; does not reveal the token) |

### Auth (any one)

- `Authorization: Bearer <INGEST_TOKEN>`
- `X-Ingest-Token: <INGEST_TOKEN>`
- `?token=<INGEST_TOKEN>` (only if the provider cannot set headers)

### Canonical JSON

```bash
curl -sS -X POST http://localhost:8000/api/ingest/email \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message_id": "<unique-id@mail.example>",
    "from_address": "parent@example.com",
    "to_address": "macon2026@inbox.example.com",
    "subject": "Withdrawal request",
    "body": "Please withdraw …",
    "received_at": "2026-07-19T15:04:05Z"
  }'
```

Response **201** (created) or **200** (`"duplicate": true` — same `message_id`):

```json
{
  "id": 42,
  "duplicate": false,
  "tournament_id": 12,
  "classification": "withdrawal",
  "status": "new",
  "message_id": "unique-id@mail.example"
}
```

Duplicate ACKs are intentional so providers do not retry forever.

### Form aliases

Recognized keys include: `from` / `sender`, `to` / `recipient`, `subject`,
`body` / `body-plain` / `stripped-text` / `text`, `body-html` / `html`,
`Message-Id` / `message_id`, `timestamp` / `Date`.

## Provider sketches

All paths need a **public HTTPS** origin (Fly / Render / Caddy). Do not expose
ingest on a laptop without a tunnel.

### Mailgun route

1. Domain → Receiving → Routes → forward / store-and-notify  
2. Action: store and notify URL  
   `https://your.host/api/ingest/email/form`  
3. Add header or query token as supported by the route.

### SendGrid Inbound Parse

Host: `https://your.host/api/ingest/email/form?token=…`  
POST fields map via the form aliases (`from`, `to`, `subject`, `text`, `html`).

### Cloudflare Email Routing + Worker

Worker receives the message, extracts headers/body, `fetch`es the JSON endpoint
with `Authorization: Bearer …`.

### Manual / scripted forward

Any tool that can HTTP POST (Zapier, Make, Power Automate, a small script on
your mail host) can use the JSON endpoint.

## Safety (minors' PII)

- Email **body** is encrypted at rest (`PII_ENCRYPTION_KEY` / Fernet).  
- Ingest logs only `id`, `tournament_id`, `classification` — **not** subject/body.  
- Endpoint is **not** admin-cookie auth; protect the token like a password.  
- Prefer a **dedicated** tournament address (not the TD’s personal mailbox).  
- Human review still files every row; no LLM reads content.

Before real junior data on a shared host: non-default admin password, real
`PII_ENCRYPTION_KEY`, TLS at the edge, and a retention plan
(`docs/pii-hardening-plan.md`).

## Local smoke test

```bash
cd backend
# migrate applies 0050_email_ingest.sql
python migrate.py
export INGEST_TOKEN=dev-only-token
uvicorn app.main:app --reload --port 8000

# in another shell
curl -sS -X POST http://localhost:8000/api/ingest/email \
  -H "X-Ingest-Token: dev-only-token" \
  -H "Content-Type: application/json" \
  -d '{"message_id":"<local-1@test>","from_address":"a@b.com","subject":"late entry","body":"Can we still register late?"}'
```

Then open the Inbox tab — the message should appear with classification
`late_entry` (keyword suggest) and status `new`.
