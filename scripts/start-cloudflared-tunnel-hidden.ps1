param(
  [string]$TunnelName = "rldb-backend"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot "runtime-logs"
$stdoutPath = Join-Path $logDir "cloudflared.out.log"
$stderrPath = Join-Path $logDir "cloudflared.err.log"
$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

$existing = Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $existing) {
  Write-Host "Cloudflared already running."
  exit 0
}

Start-Process -FilePath $cloudflaredPath `
  -ArgumentList "tunnel run $TunnelName" `
  -WindowStyle Hidden `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath

Write-Host "Started hidden cloudflared tunnel '$TunnelName'."
