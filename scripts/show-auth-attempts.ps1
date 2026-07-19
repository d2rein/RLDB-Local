param(
  [int]$Limit = 50,
  [switch]$All
)

$ErrorActionPreference = "Stop"

$query = "?limit=$Limit"
if ($All) {
  $query += "&failuresOnly=0"
}

$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://127.0.0.1:8797/api/admin/auth-attempts$query"
$payload = $response.Content | ConvertFrom-Json

if (-not $payload.ok) {
  throw "Failed to load auth attempts."
}

if (-not $payload.events -or $payload.events.Count -eq 0) {
  Write-Host "No auth attempts recorded."
  exit 0
}

$payload.events |
  Select-Object recorded_at_utc, outcome, client_ip, country, host, next_path, detail |
  Format-Table -AutoSize
