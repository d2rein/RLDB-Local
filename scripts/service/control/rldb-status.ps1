param(
  [string]$InstallRoot = "C:\RLDB",
  [int]$BackendPort = 8899,
  [int]$TelemetryPort = 8890
)

$statusPath = Join-Path $InstallRoot "runtime\status.json"
if (Test-Path -LiteralPath $statusPath) {
  Get-Content -LiteralPath $statusPath -Raw
} else {
  Write-Host "Supervisor status file is not available."
}

$updateStatusPath = Join-Path $InstallRoot "runtime\update-status.json"
if (Test-Path -LiteralPath $updateStatusPath) {
  Write-Host "Update status:"
  Get-Content -LiteralPath $updateStatusPath -Raw
}

foreach ($port in @($BackendPort, $TelemetryPort)) {
  $listener = netstat -ano | Select-String -Pattern "127\.0\.0\.1:$port\s+.*LISTENING\s+(\d+)" | Select-Object -First 1
  Write-Host "Port ${port}: $(if ($listener) { 'listening' } else { 'stopped' })"
}

try {
  $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://127.0.0.1:$BackendPort/api/health"
  Write-Host "Candidate health: HTTP $($response.StatusCode)"
} catch {
  Write-Host "Candidate health: unavailable ($($_.Exception.Message))"
}

try {
  $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://127.0.0.1:8797/api/health"
  Write-Host "Operational health: HTTP $($response.StatusCode)"
} catch {
  Write-Host "Operational health: unavailable ($($_.Exception.Message))"
}
