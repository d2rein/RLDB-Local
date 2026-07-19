param(
  [int]$Port = 8797,
  [string]$TunnelName = "rldb-backend",
  [int]$Season = (Get-Date).Year,
  [string[]]$Selections = @("NRL", "NRLW"),
  [switch]$SkipScrape
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$refreshScript = Join-Path $projectRoot "scripts\refresh-local-data.ps1"
$stopScript = Join-Path $projectRoot "scripts\stop-hybrid-backend.ps1"
$startBackendScript = Join-Path $projectRoot "scripts\start-hybrid-backend-hidden.ps1"
$startTunnelScript = Join-Path $projectRoot "scripts\start-cloudflared-tunnel-hidden.ps1"
$startWatchdogScript = Join-Path $projectRoot "scripts\start-hybrid-watchdog-hidden.ps1"

Write-Host "Stopping backend, tunnel, and watchdog before refresh..."
& $stopScript -Port $Port -IncludeTunnel -IncludeWatchdog

try {
  Write-Host "Refreshing local data..."
  if ($SkipScrape) {
    & $refreshScript -Season $Season -Selections $Selections -SkipScrape
  } else {
    & $refreshScript -Season $Season -Selections $Selections
  }
}
finally {
  Write-Host "Starting backend, tunnel, and watchdog..."
  & $startBackendScript -Port $Port
  & $startTunnelScript -TunnelName $TunnelName
  Start-Sleep -Seconds 5
  & $startWatchdogScript -Port $Port -TunnelName $TunnelName
}

Write-Host "Hybrid refresh complete."
