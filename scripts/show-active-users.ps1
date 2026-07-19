param(
  [int]$Limit = 50,
  [int]$ActiveWithinMinutes = 30
)

$ErrorActionPreference = "Stop"

$query = "?limit=$Limit&activeWithinMinutes=$ActiveWithinMinutes"
$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://127.0.0.1:8797/api/admin/active-users$query"
$payload = $response.Content | ConvertFrom-Json

if (-not $payload.ok) {
  throw "Failed to load active users."
}

if (-not $payload.users -or $payload.users.Count -eq 0) {
  Write-Host "No active users recorded in the last $ActiveWithinMinutes minute(s)."
  exit 0
}

$payload.users |
  Select-Object first_seen_utc, last_seen_utc, client_ip, country, host, last_path |
  Format-Table -AutoSize
