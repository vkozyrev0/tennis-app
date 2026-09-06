# Start the same llama.cpp sidecar image Fly uses (courtops-llm) on 127.0.0.1:8080.
# First run downloads ~1.1 GB Qwen2.5-1.5B-Instruct Q4_K_M into the compose volume.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
& (Join-Path $PSScriptRoot "download_llm.ps1")
Write-Host "Starting local LLM sidecar (same Dockerfile.llm as Fly courtops-llm)…"
docker compose -f docker-compose.llm.yml up --build -d
$deadline = (Get-Date).AddMinutes(15)
Write-Host "Waiting for http://127.0.0.1:8080/health (first boot may download the GGUF)…"
do {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8080/health" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) {
      Write-Host "LLM sidecar is up."
      Write-Host ""
      Write-Host "Point the native API at it (backend/.env):"
      Write-Host "  EMAIL_LLM=1"
      Write-Host "  EMAIL_LLM_BASE_URL=http://127.0.0.1:8080/v1"
      Write-Host "  EMAIL_LLM_TOKEN=dev-local-llm"
      Write-Host "  EMAIL_LLM_TIMEOUT=30"
      Write-Host ""
      Write-Host "Smoke (same client as Fly):"
      Write-Host "  backend/.venv/Scripts/python.exe scripts/smoke_email_llm.py"
      Write-Host "GET /api/health should then show `"llm`": `"ok`" on the site header."
      exit 0
    }
  } catch { }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $deadline)
Write-Host "Timed out waiting for /health. Logs:"
docker compose -f docker-compose.llm.yml logs --tail 80
exit 1
