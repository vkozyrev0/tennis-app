# Stop leftovers and start the local CourtOps stack via Docker Compose.
# Postgres, API, and frontend run in the `web` container (not host pg_ctl /
# uvicorn). Intelligence is the `llm` sidecar. Default is both.
#
#   .\scripts\run_local.ps1
#   .\scripts\run_local.ps1 -NoIntelligence
#   .\scripts\run_local.ps1 -Stop
#   .\scripts\run_local.ps1 -Open
#
# Site: http://127.0.0.1:8000  (admin / admin)

[CmdletBinding()]
param(
  [switch]$NoIntelligence,
  [switch]$Stop,
  [switch]$Open,
  [int]$ApiPort = 8000
)
$WithIntel = -not $NoIntelligence

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $Root "docker-compose.yml"
$LlmOnlyFile = Join-Path $Root "docker-compose.llm.yml"

function Invoke-Compose {
  param([string[]]$ComposeArgs)
  # Start-Process so docker's stderr progress is not captured as a
  # NativeCommandError array (that made $LASTEXITCODE look non-zero).
  $p = Start-Process -FilePath "docker" -ArgumentList $ComposeArgs `
    -WorkingDirectory $Root -Wait -PassThru -NoNewWindow
  return [int]$p.ExitCode
}

function Stop-ListenPort {
  param([int]$Port, [string]$Label)
  $pids = @()
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -and $_ -ne 0 })
  } catch { }
  if (-not $pids) {
    $lines = netstat -ano | Select-String ":$Port\s+.*LISTENING"
    foreach ($ln in $lines) {
      if ($ln.Line -match '\s+(\d+)\s*$') { $pids += [int]$Matches[1] }
    }
    $pids = $pids | Select-Object -Unique
  }
  foreach ($procId in $pids) {
    if ($procId -eq $PID) { continue }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $name = $p.ProcessName
    if ($name -match '^(com\.docker|docker|vpnkit|wslrelay)$') { continue }
    Write-Host "Stopping leftover $Label (PID $procId $name) on :$Port"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  if ($Label -eq "API") {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match "uvicorn app\.main:app" } |
      ForEach-Object {
        Write-Host "Stopping leftover uvicorn (PID $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
  }
}

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found. Install Docker Desktop, then re-run .\scripts\run_local.ps1"
  }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  docker info 2>$null | Out-Null
  $daemon = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($daemon -ne 0) {
    throw "Docker daemon is not running. Start Docker Desktop, then re-run .\scripts\run_local.ps1"
  }
  if (-not (Test-Path $ComposeFile)) {
    throw "Missing $ComposeFile"
  }
}

function Stop-Stack {
  Write-Host "Stopping Docker Compose stack (web + Intelligence)"
  Invoke-Compose @("compose", "--profile", "intel", "-f", $ComposeFile, "stop") | Out-Null
  if (Test-Path $LlmOnlyFile) {
    Invoke-Compose @("compose", "-f", $LlmOnlyFile, "stop") | Out-Null
  }
  Stop-ListenPort -Port $ApiPort -Label "API"
}

function Wait-HttpOk {
  param([string]$Url, [int]$Seconds, [scriptblock]$Accept)
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) {
        if (-not $Accept -or (& $Accept $r)) { return $r }
      }
    } catch { }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Start-Stack {
  $dl = Join-Path $PSScriptRoot "download_llm.ps1"
  if ($WithIntel -and (Test-Path $dl)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dl
  }

  $env:EMAIL_LLM = if ($WithIntel) { "1" } else { "0" }
  $env:ADMIN_PASSWORD = "admin"
  $env:EMAIL_LLM_CHAT_TIMEOUT = "180"

  $compose = @("compose", "-f", $ComposeFile)
  if ($WithIntel) { $compose += @("--profile", "intel") }
  $compose += @("up", "-d", "--build", "--wait", "--wait-timeout", "360")
  if (-not $WithIntel) { $compose += "web" }

  Write-Host "Starting Docker Compose ($($compose -join ' '))"
  $upCode = Invoke-Compose $compose
  if ($upCode -ne 0) {
    Invoke-Compose @("compose", "--profile", "intel", "-f", $ComposeFile, "logs", "--tail", "80") | Out-Null
    throw "docker compose up failed (exit $upCode)."
  }
}

function Wait-Site {
  $healthUrl = "http://127.0.0.1:$ApiPort/api/health"
  Write-Host "Waiting for $healthUrl"
  $r = Wait-HttpOk -Url $healthUrl -Seconds 90 -Accept {
    param($resp)
    Write-Host "Health: $($resp.Content)"
    return ($resp.Content -match '"db"\s*:\s*"ok"')
  }
  if (-not $r) {
    Invoke-Compose @("compose", "--profile", "intel", "-f", $ComposeFile, "logs", "--tail", "80") | Out-Null
    throw "API health not ok at $healthUrl"
  }
  if ($WithIntel) {
    $llm = Wait-HttpOk -Url "http://127.0.0.1:8080/health" -Seconds 180
    if (-not $llm) {
      Write-Host "WARNING: Intelligence /health not ready yet; site is up."
    } else {
      Write-Host "Intelligence sidecar is up."
    }
  }
}

function Wait-AdminLogin {
  $url = "http://127.0.0.1:$ApiPort/api/auth/login"
  $body = '{"username":"admin","password":"admin"}'
  $deadline = (Get-Date).AddSeconds(20)
  do {
    try {
      $resp = Invoke-WebRequest -Uri $url -Method POST -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 8
      if ($resp.StatusCode -eq 200) {
        Write-Host "Login check: admin/admin OK"
        return
      }
    } catch { }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  throw "admin/admin login failed against $url"
}

Write-Host "CourtOps local stack  (repo $Root)"
Write-Host "  Docker Compose  API :$ApiPort   Intelligence: $(if ($WithIntel) { ':8080' } else { 'skip' })"

Assert-Docker
Stop-Stack

if ($Stop) {
  Write-Host "Stopped. Not starting (-Stop)."
  exit 0
}

Start-Stack
Wait-Site
Wait-AdminLogin

$site = "http://127.0.0.1:$ApiPort/"
Write-Host ""
Write-Host "Open $site"
Write-Host "Sign in:  admin / admin"
Write-Host "Hard-refresh (Ctrl+F5) if chrome looks stale."
if ($Open) { Start-Process $site }
