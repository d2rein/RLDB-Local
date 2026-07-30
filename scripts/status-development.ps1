param(
  [string]$RuntimeRoot = "C:\Users\d2rei\My_Site\rldb-direct-node-runtime",
  [int]$BackendPort = 8899,
  [int]$TelemetryPort = 8890
)

function Get-Listener([int]$Port) {
  $line = netstat -ano | Select-String -Pattern "127\.0\.0\.1:$Port\s+.*LISTENING\s+(\d+)" | Select-Object -First 1
  if (-not $line) { return "stopped" }
  $match = [regex]::Match($line.Line, "LISTENING\s+(\d+)")
  if (-not $match.Success) { return "unknown" }
  return "listening (PID $($match.Groups[1].Value))"
}

Write-Host "Direct Node backend: $(Get-Listener -Port $BackendPort)"
Write-Host "Direct Node telemetry: $(Get-Listener -Port $TelemetryPort)"
try {
  $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "http://127.0.0.1:$BackendPort/api/health"
  Write-Host "Direct Node health: HTTP $($response.StatusCode)"
} catch {
  Write-Host "Direct Node health: unavailable ($($_.Exception.Message))"
}
try {
  $production = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "http://127.0.0.1:8797/api/health"
  Write-Host "Operational health: HTTP $($production.StatusCode)"
} catch {
  Write-Host "Operational health: unavailable ($($_.Exception.Message))"
}

$databasePath = Join-Path $RuntimeRoot "data\rldb.sqlite"
if (Test-Path -LiteralPath $databasePath) {
  $database = Get-Item -LiteralPath $databasePath
  Write-Host "Direct Node database: $([math]::Round($database.Length / 1GB, 3)) GiB"
}
