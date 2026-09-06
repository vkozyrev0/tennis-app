# Local email-LLM weights

This directory holds the Qwen2.5-1.5B-Instruct Q4_K_M GGUF used by the
llama.cpp sidecar (same file Fly `courtops-llm` downloads onto its volume).

**Not in git** — `*.gguf` is gitignored (~1.1 GB).

Download once:

```powershell
.\scripts\download_llm.ps1
```

That writes `models/model.gguf`. Docker Compose bind-mounts this folder at
`/models`, so later `docker compose -f docker-compose.llm.yml up` skips the
Hugging Face fetch.
