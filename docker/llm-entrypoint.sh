#!/usr/bin/env bash
# llama.cpp sidecar: persist the GGUF on /models (Fly volume or compose mount),
# then exec llama-server. First boot downloads ~1.1 GB; later boots reuse it.
set -euo pipefail

MODEL="${GGUF_PATH:-/models/model.gguf}"
URL="${GGUF_URL:-https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf}"
HOST="${LLAMA_HOST:-::}"
PORT="${LLAMA_PORT:-8080}"
MIN_BYTES="${GGUF_MIN_BYTES:-800000000}"

mkdir -p "$(dirname "$MODEL")"
size=0
if [[ -f "$MODEL" ]]; then
  size="$(wc -c < "$MODEL" | tr -d ' ')"
fi
need_fetch=0
if [[ ! -s "$MODEL" || "$size" -lt "$MIN_BYTES" ]]; then
  need_fetch=1
elif ! head -c 4 "$MODEL" | grep -q GGUF; then
  echo "[llm] $MODEL is not a GGUF file — re-downloading"
  need_fetch=1
fi
if [[ "$need_fetch" -eq 1 ]]; then
  echo "[llm] downloading GGUF → $MODEL"
  tmp="$MODEL.part"
  rm -f "$tmp"
  curl_args=(-L --retry 8 --retry-delay 5 --max-redirs 10
    -A "courtops-llm/1.0" -o "$tmp")
  if [[ -n "${HF_TOKEN:-}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${HF_TOKEN}")
  fi
  # Do not use curl --fail: some builds treat the Hugging Face 302 as an error
  # and save the 1 KB redirect body instead of following to the CDN.
  curl "${curl_args[@]}" "$URL"
  got="$(wc -c < "$tmp" | tr -d ' ')"
  if [[ "$got" -lt "$MIN_BYTES" ]] || ! head -c 4 "$tmp" | grep -q GGUF; then
    echo "[llm] download is not a GGUF ($got bytes): $(head -c 120 "$tmp" | tr '\n' ' ')" >&2
    rm -f "$tmp"
    exit 1
  fi
  mv "$tmp" "$MODEL"
fi

args=(-m "$MODEL" --host "$HOST" --port "$PORT")
KEY="${LLAMA_API_KEY:-${EMAIL_LLM_TOKEN:-}}"
if [[ -n "$KEY" ]]; then
  args+=(--api-key "$KEY")
fi
echo "[llm] starting llama-server on ${HOST}:${PORT}"
exec /app/llama-server "${args[@]}" "$@"
