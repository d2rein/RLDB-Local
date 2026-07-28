param(
  [int]$Port = 8797,
  [string]$TunnelName = "rldb-backend",
  [int]$CheckEverySeconds = 20,
  [int]$RestartAfterFailures = 1,
  [switch]$RunLoop
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendScript = Join-Path $projectRoot "scripts\start-hybrid-backend-hidden.ps1"
$tunnelScript = Join-Path $projectRoot "scripts\start-cloudflared-tunnel-hidden.ps1"
$selfScript = Join-Path $projectRoot "scripts\start-hybrid-watchdog-hidden.ps1"
$mutexName = "Local\RugbyLeagueStatsWatchdog"

if (-not $RunLoop) {
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$selfScript`" -Port $Port -TunnelName `"$TunnelName`" -CheckEverySeconds $CheckEverySeconds -RestartAfterFailures $RestartAfterFailures -RunLoop" `
    -WindowStyle Hidden `
    -WorkingDirectory $projectRoot
  Write-Host "Started hidden watchdog."
  exit 0
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
  Write-Host "Watchdog already running."
  exit 0
}

function Test-BackendHealth([int]$TargetPort) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://127.0.0.1:$TargetPort/api/health"
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

$consecutiveHealthFailures = 0

while ($true) {
  try {
    if (-not (Test-BackendHealth -TargetPort $Port)) {
      $consecutiveHealthFailures += 1
      if ($consecutiveHealthFailures -ge $RestartAfterFailures) {
        & $backendScript -Port $Port | Out-Null
        $consecutiveHealthFailures = 0
      } else {
        & $backendScript -Port $Port | Out-Null
      }
    } else {
      $consecutiveHealthFailures = 0
    }

    $cloudflared = Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $cloudflared) {
      & $tunnelScript -TunnelName $TunnelName | Out-Null
    }
  } catch {
    # Keep the watchdog alive even if one check cycle fails.
  }

  Start-Sleep -Seconds $CheckEverySeconds
}
