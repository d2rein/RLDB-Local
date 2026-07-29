param(
  [ValidateSet("status", "start", "stop", "restart", "logs")]
  [string]$Action = "status",
  [string]$Root = "C:\RLDB",
  [int]$Lines = 80
)

$ErrorActionPreference = "Stop"
$runtimeRoot = Join-Path $Root "runtime"
$controlRoot = Join-Path $runtimeRoot "control"
$statusPath = Join-Path $runtimeRoot "service-status.json"
$logRoot = Join-Path $Root "logs"
$configPath = Join-Path $Root "config\service.json"
$backendPort = 8899
if (Test-Path -LiteralPath $configPath) {
  $backendPort = [int](Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).backendPort
}

if ($Action -in @("start", "stop", "restart")) {
  New-Item -ItemType Directory -Force -Path $controlRoot | Out-Null
  $requestPath = Join-Path $controlRoot "$Action.request"
  [datetime]::UtcNow.ToString("o") | Set-Content -LiteralPath $requestPath -Encoding ascii
  Write-Host "Stage 3 $Action requested. The controller checks requests every five seconds."
  exit 0
}

if ($Action -eq "logs") {
  $files = Get-ChildItem -LiteralPath $logRoot -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if (-not $files) {
    Write-Host "No Stage 3 logs found in $logRoot."
    exit 0
  }
  foreach ($file in ($files | Select-Object -First 4)) {
    Write-Host "`n=== $($file.Name) ==="
    Get-Content -LiteralPath $file.FullName -Tail $Lines
  }
  exit 0
}

if (Test-Path -LiteralPath $statusPath) {
  Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json | Format-List
} else {
  Write-Warning "No controller status has been written yet."
}

try {
  $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$backendPort/api/health"
  Write-Host "Backend health: HTTP $($response.StatusCode)"
} catch {
  Write-Warning "Backend health check failed: $($_.Exception.Message)"
}
