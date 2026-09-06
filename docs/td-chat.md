# TD chat (local sidecar)

A Chat L1 tab lets the tournament director ask in natural language. The backend
sends a **short allowlist** plus a compact OpenAPI catalog to the **same**
llama.cpp sidecar used for leftover-email parsing (Qwen2.5-1.5B-Instruct Q4_K_M).
Writes (add/remove roster player) **do not apply** until Confirm.

Do **not** redeploy Fly `courtops-llm` unless the GGUF itself changes.

## 1.5B capability verdict

**Sufficient** for the three representative tasks on the live sidecar
(status / add player / remove player): 3/3 valid allowlisted JSON call
sequences. Caveat: the model often copies the prompt’s `"say": "short status"`
stub instead of writing a real summary. Stuffing every CourtOps router into
the prompt is still a bad idea at this size — execution stays on the
allowlist (`tournament_status`, `list_roster`, `add_player`, `remove_player`).

## API

- `GET /api/td-chat/catalog` — full OpenAPI-derived catalog (method, path, purpose, params)
- `GET /api/td-chat/verdict` — this verdict + sidecar probe
- `POST /api/td-chat/turn` `{message, tournament_id}` — plan (no writes)
- `POST /api/td-chat/execute` `{calls, confirm}` — persist mutating calls only when `confirm: true`

## Local

Sidecar already running: `http://127.0.0.1:8080/health`. Then Chat in the SPA.
`scripts/td_chat_verdict.py` re-runs the three tasks without applying writes.
