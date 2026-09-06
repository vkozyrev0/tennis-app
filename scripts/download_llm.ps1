# Download Qwen2.5-1.5B-Instruct Q4_K_M into models/model.gguf (gitignored).
# Same file Fly courtops-llm stores on volume courtops_llm.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $root "models"
$dest = Join-Path $destDir "model.gguf"
$url = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 800MB)) {
  $head = Get-Content -Path $dest -Encoding Byte -TotalCount 4
  $magic = [System.Text.Encoding]::ASCII.GetString($head)
  if ($magic -eq "GGUF") {
    Write-Host "Already have $dest ($([math]::Round((Get-Item $dest).Length/1GB, 2)) GB)"
    exit 0
  }
}

Write-Host "Downloading GGUF → $dest (~1.1 GB, excluded from git)…"
$tmp = "$dest.part"
# curl.exe follows HF 302 to the CDN; Invoke-WebRequest often does not.
& curl.exe -L --retry 8 --retry-delay 5 --max-redirs 10 -A "courtops-llm/1.0" -o $tmp $url
if (-not (Test-Path $tmp) -or ((Get-Item $tmp).Length -lt 800MB)) {
  throw "Download too small or missing: $tmp"
}
$head = Get-Content -Path $tmp -Encoding Byte -TotalCount 4
if ([System.Text.Encoding]::ASCII.GetString($head) -ne "GGUF") {
  throw "Downloaded file is not a GGUF"
}
Move-Item -Force $tmp $dest
Write-Host "Saved $dest ($([math]::Round((Get-Item $dest).Length/1GB, 2)) GB)"
