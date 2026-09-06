# TD chat (local sidecar)

A Chat tab lets the tournament director ask in natural language. The backend
sends a **short Markdown planner prompt**: executable-tool allowlist, few-shot
TD requests, then a fenced **User input** block. The full OpenAPI catalog stays
on `GET /api/td-chat/catalog` — stuffing every route into the 1.5B prompt made
it copy stubs (`short confirmation`) and invent tools (`say`, `me`). A
deterministic map (`infer_td_tools`) covers typical TD asks; replies are
formatted from executed dashboard/roster data, not from the model’s `say`
stub. Writes (add/remove roster player) **do not apply** until Confirm. Same
llama.cpp sidecar as leftover-email parsing (Qwen2.5-1.5B-Instruct Q4_K_M).

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

Planner timeout is **180s** (`EMAIL_LLM_CHAT_TIMEOUT`, default) because the
Markdown catalog is ~11k tokens of prefill on 1.5B Q4 CPU. The Chat tab shows
a spinner until the sidecar answers (client abort 200s).
